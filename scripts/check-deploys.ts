/**
 * Is each deployed application actually running the code on `main`?
 *
 * **The failure this exists for is silent.** All three deploy workflows share
 * `concurrency: { group: vps-deploy, cancel-in-progress: false }`, which bounds the queue to one
 * pending run per group: when a run is already waiting and another arrives, the waiting one is
 * **cancelled**. Two merges close together is enough, and a cancelled run is not a failed run —
 * the merge looks clean, `main` looks deployed, and the service goes on answering from an older
 * build. #390 is the incident; twelve runs have been cancelled this way between 9 and 12
 * September, and on the 12th at 11:44 UTC `app` and `be` were dropped in the same second.
 *
 * Every signal a person looks at says the deploy happened. This is the one that does not.
 *
 * **The path filters are read out of the workflows, not written here.** A copy of them in this
 * file would be a second list to keep true, and the first time it drifted this check would pass
 * by looking at the wrong commits — which is the failure mode it exists to catch, reproduced
 * inside the detector. So the globs come from `.github/workflows/<app>-deploy.yml` itself, and
 * adding a path there is picked up here with no edit.
 *
 * Read-only: `gh run list`, `git log`. Nothing is deployed, nothing is written.
 *
 *   bun run scripts/check-deploys.ts
 *
 * Exits non-zero when a deployed build is missing a commit that touched its paths, unless a run
 * for that commit is still in flight — a deploy that has not finished yet is not a dropped one.
 */
import { $ } from 'bun'

const APPS = ['app', 'be', 'landing'] as const

/**
 * The branch a deploy is supposed to carry.
 *
 * Fetched first, quietly, because a stale local `origin/main` makes this check **understate**:
 * a commit that is on the remote and not deployed would not be listed at all, and a detector
 * that misses the thing it exists to find is worse than none. A fetch failure is not fatal — the
 * answer is then as good as the last fetch, and the line below says so rather than pretending.
 */
const BASE = 'origin/main'
const fetched = await $`git fetch --quiet origin main`.nothrow().quiet()
if (fetched.exitCode !== 0) {
	console.log(`  ..  could not fetch ${BASE}; comparing against the local ref, which may be behind`)
}

type Run = {
	conclusion: string | null
	status: string
	headSha: string
	createdAt: string
}

/**
 * The `paths:` list from a workflow's `push:` trigger.
 *
 * Parsed rather than imported because these files are YAML and this repository has no YAML
 * dependency — and the shape needed here is one indented block of `- ` entries, which is small
 * enough to read directly and would be the same work with a parser.
 */
async function watchedPaths(app: string): Promise<string[]> {
	const yaml = await Bun.file(`.github/workflows/${app}-deploy.yml`).text()
	const block = yaml.match(/^ {2}push:\n(?:.*\n)*? {4}paths:\n((?: {6}- .*\n)+)/m)
	if (!block) throw new Error(`no push paths in ${app}-deploy.yml`)
	return block[1]
		.trimEnd()
		.split('\n')
		.map((line) => line.trim().slice(2))
}

let failed = false

for (const app of APPS) {
	const paths = await watchedPaths(app)
	const runs: Run[] =
		await $`gh run list --workflow ${app} --limit 40 --json conclusion,status,headSha,createdAt`.json()
	const ok = runs.find((r) => r.conclusion === 'success')
	if (!ok) {
		console.log(`${app}: no successful deploy in the last 40 runs`)
		failed = true
		continue
	}

	// Commits that touched this app's paths and are not in the deployed build. `--` separates the
	// revision range from the pathspecs, so a path that also names a branch cannot be mistaken
	// for one.
	// **Against `origin/main`, not `HEAD`.** This said `HEAD`, and run from a feature branch it
	// listed that branch's own unmerged commits as missing from production — true and useless,
	// because production is not supposed to have them. I read my own output that way once and went
	// looking for a dropped deploy that had not happened. What is deployed can only sensibly be
	// compared against what is meant to be deployed.
	const behind = (
		await $`git log --oneline ${ok.headSha}..${BASE} -- ${{ raw: paths.map((p) => `'${p}'`).join(' ') }}`.text()
	).trim()

	if (!behind) {
		console.log(`  ok  ${app}: running ${ok.headSha.slice(0, 8)}, which is current`)
		continue
	}

	// A deploy still running is not a dropped one.
	//
	// **Matched by ancestry, not against the missing list.** It used to ask whether the running
	// run's SHA appeared in `behind`, and `behind` is path-filtered — which omits merge commits,
	// because a merge's diff against its first parent touches nothing under `apps/app` even when
	// the branch it merges does. Deploys run on merge commits. So a healthy in-flight deploy
	// reported `FAIL … which is missing`, and it did that at 03:21 on deadline morning against a
	// deploy that was two minutes from landing.
	//
	// A false alarm is not a harmless alarm: this detector exists because a dropped deploy is
	// silent, and a detector that cries wolf is one people stop reading — which puts the silence
	// back.
	//
	// The question is simply whether the run carries something the deployed build does not. A run
	// whose SHA is an ancestor of what is already deployed is old news and excuses nothing; one
	// that is not is on its way.
	const flying = []
	for (const r of runs) {
		if (r.status !== 'in_progress' && r.status !== 'queued' && r.status !== 'pending') continue
		const older = await $`git merge-base --is-ancestor ${r.headSha} ${ok.headSha}`.nothrow().quiet()
		if (older.exitCode !== 0) flying.push(r)
	}
	if (flying.length > 0) {
		console.log(
			`  ..  ${app}: running ${ok.headSha.slice(0, 8)}, and a deploy for ${flying[0].headSha.slice(0, 8)} is ${flying[0].status}`,
		)
		continue
	}

	console.log(`FAIL  ${app}: running ${ok.headSha.slice(0, 8)}, which is missing:`)
	for (const line of behind.split('\n')) console.log(`        ${line}`)
	failed = true
}

if (failed) {
	console.log(
		'\nA deploy for one of these did not happen. `gh workflow run <app>` re-runs it;\n' +
			'the queue drop that causes this is #390.',
	)
	process.exit(1)
}
console.log('\nEvery deployed application is running the code on main.')

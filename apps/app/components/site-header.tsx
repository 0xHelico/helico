import Image from "next/image";
import Link from "next/link";

/** Shared by every page, so the two surfaces cannot drift apart. */
export function SiteHeader() {
  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <div className="flex items-center gap-6">
        <a className="flex items-center gap-2" href="https://helico.site">
          <Image alt="" height={26} src="/brand/mark.webp" width={26} />
          <span className="font-bold text-[17px] tracking-tight">helico</span>
        </a>
        <nav className="flex items-center gap-4 text-muted-foreground text-sm">
          <Link className="hover:text-foreground" href="/">
            Swap
          </Link>
          <Link className="hover:text-foreground" href="/mandate">
            Mandate
          </Link>
        </nav>
      </div>
      {/* Reown renders the connect button and everything behind it. */}
      <appkit-button balance="hide" />
    </header>
  );
}

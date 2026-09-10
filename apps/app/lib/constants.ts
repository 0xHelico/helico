export const isProductionEnvironment = process.env.NODE_ENV === "production";

/**
 * What a person can say to it, written for somebody who has just arrived.
 *
 * The four this replaces were all written for a returning user with money already in play: what am
 * I allowed to spend, why did you not move anything, take everything back. Three of the four are
 * dead ends on a wallet that has never opened an account, which is every wallet that meets this
 * screen for the first time. So the first three now work with nothing at all, and the two ways out
 * sit at the bottom where they reassure rather than confuse.
 *
 * **Every one was sent to the deployed backend and the action it came back as is written beside
 * it.** A starter the classifier reads as something else is a button that answers a question
 * nobody asked, and the only way to know is to ask it. Between them they cover all eight actions
 * the backend has, so nothing it can do is unreachable from this screen.
 */
export const suggestions = [
  "What can you do?", // about
  "Check my portfolio", // status
  "Put my idle USDC to work", // earn
  "Move money into my account", // deposit
  "Provide liquidity for ETH and USDC", // provide
  "Swap 0.1 ETH into USDC", // swap
  "Why has nothing moved?", // status
  "Stop the agent", // revoke
  "Take everything back to my wallet", // withdraw
];

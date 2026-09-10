import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { AppShell } from "@/components/chat/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppKitProvider } from "@/context";
import { HelicoSessionProvider } from "@/hooks/use-helico-session";
import "./globals.css";

// Geist, not Inter. The reference this app's surfaces were matched against sets both faces, and
// a page can match on spacing, weight and colour and still look unlike it, because no two glyphs
// are the same shape.
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

// `--font-mono` was declared nowhere, so every `font-mono` — every address, every figure line,
// the mandate table, the chart's dates — fell through to whatever the browser picks.
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

// The face figures are set in, so a balance reads as a quantity rather than as body text. The
// reference for this pairing is ABC Arizona, which is commercial and cannot ship from a public
// repository; Instrument Serif is the closest thing we can, and the landing already loads it, so
// the two sites read as one product. Swapping in licensed files is this one line.
const numeric = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-numeric",
});

const TITLE = "Helico | Your Funds, on Autopilot";
const DESCRIPTION =
  "Say what you want in a sentence. Helico turns it into a swap you check and sign yourself.";

// The icons and the social card are the landing's, so the three sites read as one product.
export const metadata: Metadata = {
  metadataBase: new URL("https://app.helico.site"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Helico",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Helico",
    url: "https://app.helico.site",
    title: TITLE,
    description: DESCRIPTION,
    images: [
      { url: "/og.webp", width: 512, height: 512, alt: "The Helico mark" },
    ],
  },
  twitter: {
    card: "summary",
    site: "@0xhelico",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.webp"],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e15" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const cookies = (await headers()).get("cookie");
  // Remembered across reloads, and open on a first visit: the sidebar is where the
  // conversations are, and a rail of icons does not say that.
  const collapsed = cookies?.includes("sidebar_state=false") ?? false;

  return (
    <html
      className={`${sans.variable} ${mono.variable} ${numeric.variable}`}
      lang="en"
    >
      <body className="antialiased">
        {/* Light only. Nothing sets `.dark`, so the `dark:` utilities in the chat compile
            and never match — see the note in globals.css. */}
        <AppKitProvider cookies={cookies}>
          <HelicoSessionProvider>
            <TooltipProvider>
              <AppShell defaultOpen={!collapsed}>{children}</AppShell>
            </TooltipProvider>
          </HelicoSessionProvider>
        </AppKitProvider>
        <Toaster position="top-center" />
      </body>
    </html>
  );
}

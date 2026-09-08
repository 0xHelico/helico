import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppKitProvider } from "@/context";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const TITLE = "Helico | Your Funds, on Autopilot";
const DESCRIPTION =
  "An account only you can empty. An agent puts what is idle to work and can never send it anywhere but back to you.";

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

  return (
    <html className={inter.variable} lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          {/*
            No gate. Everything this page shows is public: a mandate ledger anyone can read and
            an account address anyone can derive. Asking a visitor to sign before showing them
            public data was a habit from when the app was a conversation that had to be kept to
            one address.
          */}
          <AppKitProvider cookies={cookies}>
            <TooltipProvider>{children}</TooltipProvider>
          </AppKitProvider>
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}

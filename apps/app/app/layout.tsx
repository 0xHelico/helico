import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppKitProvider } from "@/context";
import { HelicoSessionProvider } from "@/hooks/use-helico-session";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

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
    <html className={inter.variable} lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          <AppKitProvider cookies={cookies}>
            <HelicoSessionProvider>
              <TooltipProvider>
                <SidebarProvider defaultOpen={!collapsed}>
                  <AppSidebar />
                  <SidebarInset>{children}</SidebarInset>
                </SidebarProvider>
              </TooltipProvider>
            </HelicoSessionProvider>
          </AppKitProvider>
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}

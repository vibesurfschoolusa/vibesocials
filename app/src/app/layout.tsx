import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { AppSessionProvider } from "@/components/session-provider";
import { AppShell } from "@/components/shell/app-shell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Vibe Socials | Multi-Platform Social Media Management",
  description: "Upload once, post everywhere. Manage and sync your social media content across TikTok, YouTube, Instagram, Google Business Profile, and more.",
  // iPhone ignores most of the manifest: these make "Add to Home Screen" open
  // full screen under the app's name.
  appleWebApp: {
    capable: true,
    title: "Vibe Socials",
    statusBarStyle: "default",
  },
};

// The manifest's theme colour (--primary in the light theme, see manifest.ts).
export const viewport: Viewport = {
  themeColor: "#4f46e5",
};

// Applies the saved theme override before first paint to avoid a flash. Mirrors
// the logic in components/shell/theme-toggle.tsx: "dark"/"light" force a theme,
// anything else (incl. "system") defers to the prefers-color-scheme rules.
const themeBootScript = `(function(){try{var t=localStorage.getItem('theme');var d=document.documentElement;d.classList.remove('dark','light');if(t==='dark'){d.classList.add('dark');}else if(t==='light'){d.classList.add('light');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ServiceWorkerRegistration />
        <AppSessionProvider>
          <AppShell>{children}</AppShell>
        </AppSessionProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

const display = localFont({
  src: [
    {
      path: "../assets/fonts/neue-machina-ultrabold.woff2",
      weight: "800",
      style: "normal",
    },
    {
      path: "../assets/fonts/neue-machina-regular.woff2",
      weight: "400",
      style: "normal",
    },
  ],
  variable: "--font-display",
  display: "swap",
  preload: true,
});
const body = localFont({
  src: [
    {
      path: "../assets/fonts/general-sans-regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../assets/fonts/general-sans-medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../assets/fonts/general-sans-semibold.woff2",
      weight: "600",
      style: "normal",
    },
  ],
  variable: "--font-body",
  display: "swap",
  preload: false,
});
const mono = localFont({
  src: "../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  weight: "400",
  variable: "--font-mono",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: {
    default: "useOmnis, delegation without surrendering control",
    template: "%s · useOmnis",
  },
  description:
    "Tell Omnis what needs to get paid. A bounded financial execution agent for stablecoin payments and machine commerce. Explore the interface preview.",
  icons: { icon: "/favicon.ico", apple: "/apple-icon.png" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body>
        <a href="#main" className="skip-link">
          skip to content
        </a>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

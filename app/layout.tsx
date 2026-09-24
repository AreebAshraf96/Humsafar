import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Humsafar — Carpool Pakistan",
  description: "Find and offer shared rides across Pakistan. Agree your fare, choose your company, and share your trip.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

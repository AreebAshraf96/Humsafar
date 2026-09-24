import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Humsafar — Karachi Carpool Pilot",
  description: "Find and offer shared rides in Karachi. Choose your meeting points, agree your fare, and share your trip.",
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

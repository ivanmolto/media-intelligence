import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Media Signal Service",
  description: "Boolean search and trends over enriched news articles",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-gray-900">
        <header className="border-b border-gray-200">
          <nav className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3">
            <span className="font-semibold">Media Signal</span>
            <Link href="/" className="text-blue-700 hover:underline">
              Search
            </Link>
            <Link href="/trends" className="text-blue-700 hover:underline">
              Trends
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

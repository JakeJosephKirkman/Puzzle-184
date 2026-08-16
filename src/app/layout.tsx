import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CollabSpace',
  description: 'Real-time collaborative document editing with conflict-free merging.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

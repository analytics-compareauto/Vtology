export const metadata = { title: 'Vtology', description: 'The operational ontology for the acquisition-to-sales pipeline.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f4f5f1', color: '#17201b' }}>{children}</body>
    </html>
  );
}

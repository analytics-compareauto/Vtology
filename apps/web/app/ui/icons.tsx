// Simple line icons (24px grid, 1.8 stroke) drawn for Vtology.
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const I = (d: React.ReactNode) => function Icon(props: React.SVGProps<SVGSVGElement>) { return <svg viewBox="0 0 24 24" aria-hidden="true" {...P} {...props}>{d}</svg>; };

export const IconOverview = I(<><path d="M4 13h4v7H4zM10 8h4v12h-4zM16 4h4v16h-4z" /></>);
export const IconJourneys = I(<><circle cx="5" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="M7 6h8a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8" /></>);
export const IconFindings = I(<><path d="M12 3 2.5 20h19z" /><path d="M12 10v4M12 17h.01" /></>);
export const IconPartners = I(<><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M2.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M14 14.5c2.6-.6 5.6.9 6.5 4.5" /></>);
export const IconSocial = I(<><path d="M4 19V9M9 19V5M14 19v-7M19 19V8" /><path d="M3 21h18" /></>);
export const IconApprovals = I(<><path d="M9 11l2.5 2.5L16 9" /><rect x="3.5" y="3.5" width="17" height="17" rx="4" /></>);
export const IconData = I(<><ellipse cx="12" cy="6" rx="7.5" ry="2.8" /><path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" /></>);
export const IconGrowth = I(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>);
export const IconAudience = I(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>);
export const IconMedia = I(<><rect x="3" y="5" width="18" height="12" rx="2.5" /><path d="M8 21h8M12 17v4" /><path d="M10.5 8.5v5l4-2.5z" fill="currentColor" /></>);
export const IconContent = I(<><path d="M4 5h16v11H4z" /><path d="M8 20h8" /><path d="M9 12l2-3 2 2 2-3" /></>);
export const IconUp = I(<path d="M5 15l7-7 7 7" />);
export const IconDown = I(<path d="M5 9l7 7 7-7" />);
export const IconSpark = I(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></>);
export const IconRefresh = I(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M4 4v4h4M20 20v-4h-4" /></>);
export const IconPlay = I(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l6-3.5z" fill="currentColor" /></>);
export const IconImage = I(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="m4 18 5-5 4 4 2.5-2.5L20 18" /></>);
export const IconText = I(<path d="M5 6h14M5 11h14M5 16h9" />);
export const IconCar = I(<><path d="M4 16v-3l2-5h12l2 5v3z" /><circle cx="7.5" cy="16.5" r="1.8" /><circle cx="16.5" cy="16.5" r="1.8" /></>);
export const IconBank = I(<><path d="M3 9.5 12 4l9 5.5M5 10v7M10 10v7M14 10v7M19 10v7M3 20h18" /></>);
export const IconBasket = I(<><path d="M4 9h16l-1.5 10h-13zM8 9l3-5M16 9l-3-5" /></>);

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  // a flow line crossing a waterline: what moves forward above, what leaks below
  return (
    <svg className={className} viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="#2f5bd8" />
      <path d="M5 9.5 11 18l4-6 3 4 5-7.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 21h18" stroke="#f5a524" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

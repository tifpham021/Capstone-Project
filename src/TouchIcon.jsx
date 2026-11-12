export default function TouchIcon({ name = 'scan' }) {
  const paths = {
    sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="M20 2v4m-2-2h4" /></>,
    scan: <><path d="M4 8V4h4m8 0h4v4M4 16v4h4m8 0h4v-4M7 12h10" /></>,
    camera: <><path d="m8 5 1-2h6l1 2h4a1 1 0 0 1 1 1v13H3V6a1 1 0 0 1 1-1Z" /><circle cx="12" cy="12" r="4" /></>,
    photo: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m4 19 7-7 4 4 3-3 3 3" /></>,
    shield: <><path d="m12 2 8 4v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 11 3 3 5-5" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path d="m3 3 18 18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
  }
  return <svg className="touch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.scan}</svg>
}

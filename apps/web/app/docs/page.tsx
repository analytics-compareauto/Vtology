const ENDPOINTS: [string, string, string][] = [
  ['GET', '/api/health', 'Service status'],
  ['POST', '/api/auth/login', 'Sign in with email and password'],
  ['POST', '/api/auth/refresh', 'Renew a session'],
  ['GET', '/api/workspaces', 'Workspaces you belong to'],
  ['POST', '/api/workspaces', 'Create a workspace, optionally with sample data'],
  ['POST', '/api/tenants/:tenant/sample/role', 'Switch your role (sample workspaces only)'],
  ['GET', '/api/tenants/:tenant/partners/directory', 'Partner names, for choosing a reassignment target'],
  ['GET', '/api/tenants/:tenant/me', 'Your role and scope in a tenant'],
  ['POST', '/api/tenants/:tenant/imports', 'Import a CSV export through a field mapping'],
  ['POST', '/api/tenants/:tenant/pipeline/run', 'Resolve identities, link journeys, run detectors'],
  ['GET', '/api/tenants/:tenant/journeys?stalled=true', 'Journeys, with stalled ones flagged'],
  ['GET', '/api/tenants/:tenant/partners', 'Partner scorecard'],
  ['GET', '/api/tenants/:tenant/violations', 'Lying-data findings from the latest run'],
  ['POST', '/api/tenants/:tenant/actions', 'Request a governed action'],
  ['POST', '/api/tenants/:tenant/actions/:id/approve', 'Approve a pending action'],
  ['POST', '/api/tenants/:tenant/actions/:id/reject', 'Reject a pending action'],
  ['GET', '/api/tenants/:tenant/actions', 'Action log'],
];

export const metadata = { title: 'Vtology API' };

export default function Docs() {
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '48px 16px' }}>
      <h1 style={{ marginBottom: 4 }}>Vtology API</h1>
      <p style={{ color: '#4b544e', marginTop: 0 }}>Version 0.2. Every call except health and sign-in needs an access token in the Authorization header.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <tbody>
          {ENDPOINTS.map(([m, p, d]) => (
            <tr key={m + p} style={{ borderBottom: '1px solid #d9ddd4' }}>
              <td style={{ padding: '8px 6px', fontFamily: 'monospace', fontWeight: 600 }}>{m}</td>
              <td style={{ padding: '8px 6px', fontFamily: 'monospace' }}>{p}</td>
              <td style={{ padding: '8px 6px', color: '#4b544e' }}>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

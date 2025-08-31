import Head from 'next/head';
import Link from 'next/link';

type PageKey = 'home' | 'extension' | 'support' | 'privacy' | 'terms';

const CWS_URL = process.env.NEXT_PUBLIC_CWS_URL || '';

function slugToPage(slug?: string[]): PageKey {
  const s = (slug?.[0] || '').toLowerCase();
  if (s === 'extension') return 'extension';
  if (s === 'support') return 'support';
  if (s === 'privacy') return 'privacy';
  if (s === 'terms') return 'terms';
  return 'home';
}

function titleFor(page: PageKey) {
  switch (page) {
    case 'extension':
      return 'Install the TrueTrend Chrome Extension';
    case 'support':
      return 'Support — TrueTrend';
    case 'privacy':
      return 'Privacy Policy — TrueTrend';
    case 'terms':
      return 'Terms of Service — TrueTrend';
    default:
      return 'TrueTrend — Learn Your Money. Earn Your Money. Own Your Money.';
  }
}

function descriptionFor(page: PageKey) {
  switch (page) {
    case 'extension':
      return 'Install TrueTrend from the Chrome Web Store or load it unpacked for testing.';
    case 'support':
      return 'Get help with TrueTrend. Common fixes and how to contact support.';
    case 'privacy':
      return 'TrueTrend privacy policy. Minimal data, no selling of personal information.';
    case 'terms':
      return 'TrueTrend Terms of Service and trading disclaimer.';
    default:
      return 'TrueTrend overlays strategies, alerts, and guidance on your chart. Timeframes: 1m, 5m, 15m, 30m, 1h, 4h, Daily, Monthly.';
  }
}

function InstallButton() {
  if (!CWS_URL) {
    return (
      <a href="/extension#coming-soon" className="btn btn-primary">
        Add to Chrome (coming soon)
      </a>
    );
  }
  return (
    <a href={CWS_URL} className="btn btn-primary" rel="noopener noreferrer">
      Add to Chrome
    </a>
  );
}

function Home() {
  return (
    <section>
      <h1>Learn Your Money. Earn Your Money. Own Your Money.</h1>
      <p className="lead">
        TrueTrend overlays strategies, alerts, and guidance right on top of your chart.
        Pick a timeframe (1m, 5m, 15m, 30m, 1h, 4h, Daily, Monthly), select a strategy,
        attach to the chart, and go.
      </p>
      <InstallButton />
      <ul className="grid">
        <li>• Strategy dropdown with Stocks, Options, Futures &amp; Forex sets</li>
        <li>• Voice alerts, replay, and quick “Analyze”</li>
        <li>• Clean, compact dock with auto-analyze on selection</li>
      </ul>
    </section>
  );
}

function Extension() {
  return (
    <article className="prose">
      <h1>Install TrueTrend</h1>
      {CWS_URL ? (
        <>
          <p>Click the button below to open our Chrome Web Store listing.</p>
          <InstallButton />
        </>
      ) : (
        <>
          <p id="coming-soon"><strong>Chrome Web Store link coming soon.</strong></p>
          <p>For manual testing:</p>
          <ol>
            <li>Download the tester ZIP and unzip it.</li>
            <li>Open <code>chrome://extensions</code> and enable <em>Developer mode</em>.</li>
            <li>Click <em>Load unpacked</em> → select the unzipped folder.</li>
          </ol>
        </>
      )}

      <h2>Quick start</h2>
      <ol>
        <li>Open your chart site (e.g., pocketoption.com).</li>
        <li>Select Symbol → Timeframe (1m, 5m, 15m, 30m, 1h, 4h, Daily, Monthly).</li>
        <li>Choose a Strategy from the dropdown (Stocks/Options/Futures &amp; Forex panels).</li>
        <li>Click <strong>Attach</strong> → <strong>Analyze</strong>. You can enable auto-analyze on selection.</li>
      </ol>
    </article>
  );
}

function Support() {
  return (
    <article className="prose">
      <h1>Support</h1>
      <p>
        Need help? Email <a href="mailto:support@trytruetrend.com">support@trytruetrend.com</a>.
        We usually reply within one business day.
      </p>

      <h2>Common fixes</h2>
      <ul>
        <li><strong>Not attaching:</strong> make sure the site tab is active and not private/incognito.</li>
        <li><strong>Only icons showed on load:</strong> unzip first, then select the folder.</li>
        <li><strong>Missing timeframes:</strong> update to the latest version (1m–4h, Daily, Monthly).</li>
      </ul>

      <h2>Great bug reports include</h2>
      <ul>
        <li>What happened vs. what you expected</li>
        <li>Symbol, timeframe, and strategy you used</li>
        <li>Browser + OS version, plus a short screen recording if possible</li>
      </ul>
    </article>
  );
}

function Privacy() {
  const lastUpdated = new Date().toLocaleDateString();
  return (
    <article className="prose">
      <h1>Privacy Policy</h1>
      <p>Last updated: {lastUpdated}</p>

      <p>
        TrueTrend (“we”, “us”) collects the minimum necessary data to operate the extension and website and does not sell personal information.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Extension data:</strong> settings you choose (e.g., symbol, timeframe, strategy) are stored locally in your browser.</li>
        <li><strong>Support:</strong> if you email us, we receive your message and email address.</li>
        <li><strong>Site analytics:</strong> we may use privacy-friendly analytics in aggregate.</li>
      </ul>

      <h2>What we don’t collect</h2>
      <ul>
        <li>No account sign-up required for the extension.</li>
        <li>No personal browsing history outside pages where you enable the extension.</li>
        <li>No sale of personal data.</li>
      </ul>

      <h2>Third-party services</h2>
      <p>
        Optional market data integrations (TwelveData, Finnhub, Polygon, etc.) may use your own API keys. Keys are stored locally and used only for your requests.
      </p>

      <h2>Data retention</h2>
      <p>Support emails are retained as needed to resolve issues and for recordkeeping.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Disable/remove the extension at any time in <code>chrome://extensions</code>.</li>
        <li>Email us to request deletion of support communications.</li>
      </ul>

      <h2>Contact</h2>
      <p>Email: <a href="mailto:privacy@trytruetrend.com">privacy@trytruetrend.com</a></p>
    </article>
  );
}

function Terms() {
  const lastUpdated = new Date().toLocaleDateString();
  return (
    <article className="prose">
      <h1>Terms of Service</h1>
      <p>Last updated: {lastUpdated}</p>

      <h2>License</h2>
      <p>
        We grant you a limited, non-exclusive, non-transferable license to use the TrueTrend extension and site for personal or internal business purposes.
      </p>

      <h2>Trading disclaimer</h2>
      <p>
        TrueTrend is educational/informational only and does not constitute financial advice. Markets involve risk. You are solely responsible for your decisions and outcomes.
      </p>

      <h2>Availability</h2>
      <p>
        We may update, suspend, or discontinue features at any time. We strive for high availability but do not guarantee uninterrupted service.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, TrueTrend is not liable for any indirect, incidental, consequential, or special damages, or for trading losses.
      </p>

      <h2>Acceptable use</h2>
      <p>
        You agree not to reverse engineer, abuse, or interfere with the Services, nor circumvent technical protections.
      </p>

      <h2>Contact</h2>
      <p>Email: <a href="mailto:legal@trytruetrend.com">legal@trytruetrend.com</a></p>

      <p className="muted">
        Note: This is a short, practical summary. For bespoke legal language, consult an attorney.
      </p>
    </article>
  );
}

export default function CatchAllPage({ slug }: { slug?: string[] }) {
  const page = slugToPage(slug);
  const title = titleFor(page);
  const desc = descriptionFor(page);
  const url = `https://trytruetrend.com${page === 'home' ? '/' : `/${slug?.[0]}`}`;

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={desc} />
        <link rel="canonical" href={url} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={desc} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={url} />
      </Head>

      <div className="wrap">
        <header className="header">
          <Link href="/" className="brand">TrueTrend</Link>
          <nav className="nav">
            <Link href="/extension">Extension</Link>
            <Link href="/support">Support</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
        </header>

        <main className="main">
          {page === 'home' && <Home />}
          {page === 'extension' && <Extension />}
          {page === 'support' && <Support />}
          {page === 'privacy' && <Privacy />}
          {page === 'terms' && <Terms />}
        </main>

        <footer className="footer">
          © {new Date().getFullYear()} TrueTrend. All rights reserved.
        </footer>
      </div>

      <style jsx global>{`
        :root { --bg: #0b1220; --fg: #e6eaf3; --muted: #9aa3b2; --card: #10192b; --border: #223049; --primary: #2b6cff; }
        html, body { background: var(--bg); color: var(--fg); padding: 0; margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji','Segoe UI Emoji'; }
        a { color: var(--fg); text-decoration: none; }
        .wrap { max-width: 1000px; margin: 0 auto; padding: 0 20px; }
        .header { display:flex; align-items:center; justify-content:space-between; padding: 22px 0; }
        .brand { font-weight: 700; letter-spacing: .3px; }
        .nav a { margin-left: 18px; color: var(--muted); }
        .nav a:hover { color: var(--fg); }
        .main { padding: 10px 0 60px; }
        h1 { font-size: 32px; margin: 0 0 10px; }
        h2 { margin-top: 28px; }
        .lead { color: var(--muted); max-width: 720px; }
        .grid { margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fit,minmax(280px,1fr)); gap: 10px; color: var(--muted); }
        section, article { background: var(--card); border: 1px solid var(--border); padding: 20px; border-radius: 12px; }
        .prose p, .prose li { color: var(--fg); }
        .prose code { background: #0e1526; padding: 1px 6px; border-radius: 6px; }
        .btn { display:inline-flex; align-items:center; justify-content:center; padding: 10px 16px; border-radius: 10px; font-weight: 600; }
        .btn-primary { background: var(--primary); color:white; }
        .btn-primary:hover { filter: brightness(1.05); }
        .footer { border-top: 1px solid var(--border); color: var(--muted); font-size: 14px; padding: 24px 0 40px; }
        .muted { color: var(--muted); font-size: 12px; }
      `}</style>
    </>
  );
}

// Pages Router catch-all to capture /, /extension, /support, /privacy, /terms
export async function getServerSideProps(ctx: any) {
  const slug = (ctx.params?.slug || []) as string[];
  return { props: { slug } };
}

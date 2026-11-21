import { Link } from "react-router-dom";

export default function Privacy() {
  return (
    <main className="min-h-screen bg-background text-foreground px-5 py-12">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="space-y-2">
          <Link to="/" className="text-xs text-primary hover:underline">
            ← Tatani
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Privacy Policy & Data Deletion</h1>
          <p className="text-xs text-muted-foreground">Effective date: November 2026 · App ID: app.tatani.android</p>
        </div>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">1. Data We Collect</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Tatani collects only the minimum data needed to synchronize your language study across devices:
          </p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
            <li>Account credentials (email address and authentication identifier via Supabase Auth).</li>
            <li>Vocabulary study state, spaced-repetition intervals, quiz history, and selected anime library entries.</li>
            <li>Optional push notification device tokens when flashcard notifications are explicitly enabled.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">2. How We Use & Protect Data</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            All network traffic is encrypted in transit over HTTPS/TLS. Study data is used exclusively to schedule
            flashcard reviews and personalize episode vocabulary. Tatani does not sell personal data, display
            third-party advertising, or share user data with data brokers.
          </p>
        </section>

        <section id="delete-data" className="space-y-2">
          <h2 className="text-lg font-semibold">3. Account & Data Deletion</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            You can permanently delete your study history, anime library, notification tokens, and progress data at any
            time directly inside the app:
          </p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
            <li>
              <strong>Android app:</strong> Open <em>Library → Account &amp; Privacy (top-right) → Delete my study &amp; account data</em>.
            </li>
            <li>
              <strong>Web app:</strong> Sign in at{" "}
              <Link to="/settings" className="text-primary hover:underline">
                Settings
              </Link>{" "}
              and select <em>Reset study data</em> / <em>Wipe anime data</em>.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

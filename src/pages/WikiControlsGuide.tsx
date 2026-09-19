import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const Control: React.FC<{ icon: string; name: string; analogy: string; children: React.ReactNode }> = ({
  icon,
  name,
  analogy,
  children,
}) => (
  <div className="bg-surface-container-low rounded-2xl p-5 md:p-6 border border-outline-variant/10">
    <div className="flex items-start gap-3 mb-2">
      <span className="material-symbols-outlined text-2xl text-accent shrink-0" aria-hidden>{icon}</span>
      <div>
        <h4 className="font-headline font-bold text-xl text-primary leading-tight">{name}</h4>
        <p className="text-on-surface-variant italic font-headline text-sm mt-0.5">{analogy}</p>
      </div>
    </div>
    <div className="text-foreground/90 font-body text-[15px] leading-relaxed pl-9 space-y-2">{children}</div>
  </div>
);

const Group: React.FC<{ title: string; subtitle: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <section className="mb-12">
    <h3 className="font-headline font-bold text-3xl text-primary mb-1">{title}</h3>
    <p className="text-on-surface-variant font-body mb-5">{subtitle}</p>
    <div className="space-y-4">{children}</div>
  </section>
);

const WikiControlsGuide: React.FC = () => {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl border-b border-outline-variant/15">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm font-body font-medium text-primary hover:text-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Back to Neuron
          </Link>
          <span className="text-[11px] uppercase tracking-wider font-bold text-on-surface-variant">
            Field Guide
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12 pb-32">
        <div className="mb-12">
          <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[11px] font-bold tracking-wider uppercase">
            Neuron Tab
          </span>
          <h1 className="font-headline font-bold text-4xl md:text-5xl text-primary tracking-tight mt-3 mb-4">
            A Quick Tour of the Neuron Tab
          </h1>
          <p className="text-on-surface-variant text-lg font-body leading-relaxed">
            The Neuron tab shows what your AI actually knows. Here's the plain-English tour —
            most of it you'll rarely need, because the tab mostly runs itself.
          </p>
        </div>

        <section className="mb-12 bg-primary-container/40 rounded-2xl p-6 md:p-8">
          <h2 className="font-headline font-bold text-2xl text-on-primary-container mb-2">
            The 30-second version
          </h2>
          <p className="text-on-primary-container/90 font-body leading-relaxed">
            Most days you just <strong>chat</strong> and your neurons grow on their own. Pop in here to{" "}
            <strong>resolve conflicts</strong> when an amber chip appears, and glance at the{" "}
            <strong>health ring</strong> now and then. That's it — everything else lives in the{" "}
            <strong>⋯ care menu</strong> for when you're curious.
          </p>
        </section>

        <Group title="Scope & identity" subtitle="What you're looking at right now.">
          <Control icon="join" name="Loaded-neuron chips" analogy="The notebooks open on your desk right now.">
            <p>
              The chips under the title are the neurons currently loaded — the exact set Counsel reads when you
              chat. The one with the <strong>★</strong> is the <strong>primary</strong>: new knowledge saves there.
            </p>
            <p>
              <strong>Tap a chip</strong> to focus the view on just that neuron; tap it again to widen back out.{" "}
              <strong>+ Load</strong> opens the ⌘K switcher to load another neuron alongside (up to 5), and{" "}
              <strong>Save chain</strong> keeps the current combo so you can re-activate it in one click later.
              2–3 related neurons is the sweet spot — mixing related topics is one of the best-proven ways to make
              learning stick.
            </p>
          </Control>
          <Control icon="filter_alt" name="Loaded vs. Everything" analogy="The open notebooks, or the whole bookshelf?">
            <p>
              <strong>Loaded</strong> shows the neurons you're working with — what Counsel actually sees.{" "}
              <strong>Everything</strong> shows every entry across every neuron you've ever made, loaded or not.
            </p>
            <p>Stay on "Loaded" for normal work. Flip to "Everything" when you can't remember which neuron something is in.</p>
          </Control>
          <Control icon="fiber_manual_record" name="Memory chip" analogy="Pen down vs. pen up.">
            <p>
              The little pill that says <strong>"Memory on — saving to …"</strong> is Counsel's pen: while it reads
              "on", new knowledge from your chats is saved to the primary neuron (on most devices the dot beside it
              gently breathes too).
            </p>
            <p>
              Click it to pause: <strong>"Memory paused"</strong> means Counsel still answers from your neurons but
              writes nothing new — and that applies to <em>all</em> neurons until you resume.
            </p>
          </Control>
        </Group>

        <Group title="Status at a glance" subtitle="The two signals worth acting on.">
          <Control icon="health_and_safety" name="Health ring" analogy="A checkup, one glance.">
            <p>
              The ring shows the last health score for the neuron you're viewing. Click it to run a fresh check —
              it scans for duplicates, lonely entries, and anything that looks off, then shows you the report with
              one-tap fixes.
            </p>
          </Control>
          <Control icon="report" name="Conflicts chip" analogy="Two notes that disagree.">
            <p>
              When two entries say opposite things ("the meeting is Monday" vs. "Tuesday"), an amber chip appears
              with the count. Open it, compare the pair side by side, and tap <strong>"Keep this one"</strong> on
              the entry that's right — you'll always be told exactly what gets deleted before anything happens.
            </p>
            <p>No chip = nothing needs you.</p>
          </Control>
        </Group>

        <Group title="The ⋯ care menu" subtitle="Occasional tools, out of the way until you want them.">
          <Control icon="bedtime" name="Consolidate knowledge (Sleep Cycle)" analogy="A good night's sleep for your neuron.">
            <p>
              Connects lonely entries to their neighbors, merges duplicates, and quietly cleans the web of links —
              just like real sleep consolidates memory. It also runs automatically once a day while you're using the
              app, so the manual button is mostly for right after a big reading session.
            </p>
          </Control>
          <Control icon="memory" name="Rebuild search" analogy="Re-sharpening the search.">
            <p>Refreshes the index behind semantic search ("find me entries about X"). Run it if search feels stale.</p>
          </Control>
          <Control icon="history" name="Chat history" analogy="A diary of past conversations.">
            <p>Every saved chat gets a short summary. Browse them to remember what you covered last week.</p>
          </Control>
          <Control icon="pending_actions" name="Pending tidy-ups" analogy="The to-do list for the next consolidation.">
            <p>Entries waiting to be linked up or reviewed. Purely informational — the next consolidation clears it.</p>
          </Control>
          <Control icon="more_horiz" name="Conflict history & Refresh" analogy="The archive drawer and the reload lever.">
            <p>
              <strong>Conflict history</strong> appears in the menu once you've resolved past conflicts — a record of
              old disagreements, all settled. <strong>Refresh data</strong> simply reloads the tab from the server.
            </p>
          </Control>
          <Control icon="settings" name="Neuron settings" analogy="The control panel.">
            <p>Pick which AI model your neurons use and tune advanced behavior. Lives in the Settings tab.</p>
          </Control>
        </Group>

        <Group title="Finding things" subtitle="Search and slice the knowledge itself.">
          <Control icon="search" name="Search & type filters" analogy="Sort by what kind of card.">
            <p>
              Search covers titles, content, and tags across your current scope. The filter pills narrow by entry
              type: <em>concepts</em>, <em>entities</em>, <em>facts</em>, <em>syntheses</em>, <em>summaries</em>,{" "}
              <em>comparisons</em>.
            </p>
          </Control>
          <Control icon="hub" name="Mind map & list" analogy="The web, or the index cards.">
            <p>
              The mind map shows entries as glowing nodes connected by relationships — with several neurons loaded
              (or in Everything scope), hover a node or scan a card's byline to see which neuron it came from. The
              list view is the same knowledge as scannable cards, one tap away.
            </p>
          </Control>
        </Group>

        <div className="text-center pt-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-bold active:scale-95 transition-transform shadow-lg"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Back to Neuron
          </Link>
        </div>
      </main>
    </div>
  );
};

export default WikiControlsGuide;

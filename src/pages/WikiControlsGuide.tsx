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
      <span className="material-symbols-outlined text-2xl text-accent shrink-0">{icon}</span>
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
            <ArrowLeft className="w-4 h-4" />
            Back to Neuron
          </Link>
          <span className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
            Field Guide
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12 pb-32">
        <div className="mb-12">
          <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
            NEURON TAB
          </span>
          <h1 className="font-headline font-bold text-5xl md:text-6xl text-primary tracking-tight mt-3 mb-4">
            What All These Buttons Do
          </h1>
          <p className="text-on-surface-variant text-lg font-body leading-relaxed">
            The Neuron tab has a lot of controls. Most of them you'll only touch once in a while.
            Here's a plain-English tour so nothing feels mysterious.
          </p>
        </div>

        <section className="mb-12 bg-primary-container/40 rounded-2xl p-6 md:p-8">
          <h2 className="font-headline font-bold text-2xl text-on-primary-container mb-2">
            The 30-second version
          </h2>
          <p className="text-on-primary-container/90 font-body leading-relaxed">
            Most days you just <strong>chat</strong> and the neuron grows on its own. Pop in here to{" "}
            <strong>resolve conflicts</strong> when a number appears, and once a week run{" "}
            <strong>Sleep Cycle</strong> and <strong>Health Check</strong> to tidy things up. That's it.
          </p>
        </section>

        <Group title="Scope & identity" subtitle="What you're looking at right now.">
          <Control icon="filter_alt" name="This Neuron vs. All Neurons" analogy="One notebook, or all notebooks at once?">
            <p>
              <strong>This Neuron</strong> shows only the wiki you've loaded — focused view.
              <strong> All Neurons</strong> shows everything you've ever saved across every wiki.
            </p>
            <p>Pick "This Neuron" for normal work. Pick "All Neurons" when you can't remember which wiki something is in.</p>
          </Control>
          <Control icon="swap_horiz" name="Neuron switcher dropdown" analogy="The bookshelf next to your desk.">
            <p>Jump straight to another neuron without going back to the Neurons page. Handy when you bounce between projects.</p>
          </Control>
        </Group>

        <Group title="Day-to-day controls" subtitle="The two you'll actually use often.">
          <Control icon="report" name="Conflicts" analogy="Two notes that disagree with each other.">
            <p>
              When two cards say opposite things ("the meeting is Monday" vs. "Tuesday"), the system flags
              them. Click here to review each pair and pick the right answer.
            </p>
            <p>The red number = how many need your attention. Zero = you're all caught up.</p>
          </Control>
          <Control icon="edit" name="Recording / Retrieval mode" analogy="Pen down vs. pen up.">
            <p>
              <strong>Recording mode</strong> — the AI writes new cards as you chat. The default.
            </p>
            <p>
              <strong>Retrieval mode</strong> — read-only. The AI can answer questions using the neuron but
              won't add anything new. Use this when you want pure Q&A without growing the library.
            </p>
          </Control>
        </Group>

        <Group title="Tidy-up tools" subtitle="Run these once in a while. They keep the neuron sharp.">
          <Control icon="bedtime" name="Sleep Cycle" analogy="A good night's sleep for your neuron.">
            <p>
              Connects lonely cards to their neighbors, merges duplicates, and quietly cleans the web of
              links. Just like real sleep helps your brain consolidate.
            </p>
            <p>Good habit: run it after a big chat session.</p>
          </Control>
          <Control icon="health_and_safety" name="Health Check" analogy="A quick checkup.">
            <p>
              Scans the neuron for problems — broken links, weird empty cards, anything that looks off — and
              shows you what it found. Run it when something feels wrong.
            </p>
          </Control>
          <Control icon="memory" name="Reindex" analogy="Re-sharpening the search.">
            <p>
              Rebuilds the search index so semantic search ("find me cards about X") stays accurate. Run
              it if search results feel stale or you just imported a lot.
            </p>
          </Control>
          <Control icon="refresh" name="Refresh" analogy="Pull-to-refresh.">
            <p>Just reloads the page's data from the server. Nothing fancy.</p>
          </Control>
        </Group>

        <Group title="Browse the history" subtitle="See what's been happening behind the scenes.">
          <Control icon="history" name="Episodes" analogy="A diary of past chats.">
            <p>
              Every conversation gets a short summary. Browse them to remember what you talked about last
              week — or last month.
            </p>
          </Control>
          <Control icon="pending_actions" name="Queue" analogy="The to-do list for the next Sleep Cycle.">
            <p>Cards waiting in line to be linked up and processed. Useful if you're curious what's pending.</p>
          </Control>
        </Group>

        <Group title="Settings & filters" subtitle="Less common, but here when you need them.">
          <Control icon="settings" name="Settings (gear icon)" analogy="The control panel.">
            <p>
              Pick which AI model this neuron uses, change advanced options, and tweak how the neuron behaves.
            </p>
          </Control>
          <Control icon="filter_list" name="Type filters" analogy="Sort by what kind of card.">
            <p>
              Inside the entries list you can filter by card type: <em>concept</em>, <em>entity</em>,{" "}
              <em>fact</em>, <em>synthesis</em>, <em>summary</em>, <em>comparison</em>. Helps you find a
              specific flavor of knowledge fast.
            </p>
          </Control>
        </Group>

        <div className="text-center pt-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-bold active:scale-95 transition-transform shadow-lg"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Neuron
          </Link>
        </div>
      </main>
    </div>
  );
};

export default WikiControlsGuide;

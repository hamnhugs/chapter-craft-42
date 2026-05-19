import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const Section: React.FC<{ icon: string; title: string; analogy: string; children: React.ReactNode }> = ({
  icon,
  title,
  analogy,
  children,
}) => (
  <section className="bg-surface-container-low rounded-2xl p-6 md:p-8 border border-outline-variant/10">
    <div className="flex items-start gap-4 mb-3">
      <span className="material-symbols-outlined text-3xl text-accent shrink-0">{icon}</span>
      <div>
        <h3 className="font-headline font-bold text-2xl text-primary">{title}</h3>
        <p className="text-on-surface-variant italic font-headline text-base mt-0.5">{analogy}</p>
      </div>
    </div>
    <div className="text-foreground/90 font-body leading-relaxed space-y-3">{children}</div>
  </section>
);

const Term: React.FC<{ word: string; children: React.ReactNode }> = ({ word, children }) => (
  <div className="py-3 border-b border-outline-variant/15 last:border-0">
    <div className="font-headline font-bold text-primary text-lg">{word}</div>
    <p className="text-on-surface-variant font-body text-sm mt-1 leading-relaxed">{children}</p>
  </div>
);

const MemoryGuide: React.FC = () => {
  return (
    <div className="min-h-screen bg-background">
      {/* Sticky top bar */}
      <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl border-b border-outline-variant/15">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm font-body font-medium text-primary hover:text-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Wikis
          </Link>
          <span className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
            Field Guide
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12 pb-32">
        {/* Hero */}
        <div className="mb-12">
          <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
            How It Works
          </span>
          <h1 className="font-headline font-bold text-5xl md:text-6xl text-primary tracking-tight mt-3 mb-4">
            The Memory System, Explained
          </h1>
          <p className="text-on-surface-variant text-lg font-body leading-relaxed">
            Your wikis aren't just folders of notes — they're a living memory that learns,
            connects, and tidies itself up over time. Here's how it works, in plain English.
          </p>
        </div>

        {/* The Big Picture */}
        <section className="mb-12 bg-primary-container/40 rounded-2xl p-6 md:p-8">
          <h2 className="font-headline font-bold text-2xl text-on-primary-container mb-3">
            The big picture
          </h2>
          <p className="text-on-primary-container/90 font-body leading-relaxed">
            Think of the system like a <strong>brain with five kinds of memory</strong>. Each kind
            has its own job. Together, they let the AI remember what you told it, find the right
            fact at the right moment, and improve quietly in the background — just like sleep
            cleans up a real brain.
          </p>
        </section>

        {/* The five layers */}
        <h2 className="font-headline font-bold text-3xl text-primary mb-6">The five layers</h2>
        <div className="space-y-5 mb-16">
          <Section icon="desk" title="Working Memory" analogy="Your desk">
            <p>
              This is what's <strong>in front of you right now</strong> — the chat you're having,
              the page you're reading, the wiki you just opened. It's temporary. When you close
              the tab or switch wikis, the desk gets cleared.
            </p>
            <p>You don't manage this layer. It just keeps the current moment ready.</p>
          </Section>

          <Section icon="auto_stories" title="Episodic Memory" analogy="A diary">
            <p>
              Every conversation you have gets a short diary entry: <em>"On Tuesday we talked
              about X, and the key takeaways were Y and Z."</em>
            </p>
            <p>
              This lets the AI <strong>pick up where you left off</strong> — even weeks later — and
              remember the gist of past chats without re-reading every word.
            </p>
          </Section>

          <Section icon="hub" title="Semantic Memory" analogy="A filing cabinet with webs between cards">
            <p>
              This is the big one. Every fact, person, idea, or concept becomes a{" "}
              <strong>card</strong> (an "entry"). Cards are linked to other related cards, forming
              a web — the <strong>memory graph</strong>.
            </p>
            <p>
              When you ask a question, the AI doesn't just find one card — it follows the links
              to nearby cards too. That's how it gives answers that feel <em>connected</em>
              instead of disjointed.
            </p>
          </Section>

          <Section icon="receipt_long" title="Procedural Memory" analogy="Recipe cards">
            <p>
              A special kind of card for <strong>step-by-step knowledge</strong>: "how to do X",
              "the process for Y", "the rules of Z."
            </p>
            <p>
              The AI pulls these out whenever you ask it to <em>do</em> something rather than{" "}
              <em>recall</em> something.
            </p>
          </Section>

          <Section icon="bedtime" title="Sleep Cycle (Consolidation)" analogy="A night cleanup crew">
            <p>
              In the background, the system runs a "sleep cycle." It looks for{" "}
              <strong>lonely cards</strong> with no links, <strong>contradictions</strong> between
              cards, and <strong>duplicates</strong>.
            </p>
            <p>
              It quietly stitches the web together, flags conflicts for you to resolve, and keeps
              the whole library tidy — so it stays useful as it grows.
            </p>
          </Section>
        </div>

        {/* Glossary */}
        <h2 className="font-headline font-bold text-3xl text-primary mb-2">Words you'll see</h2>
        <p className="text-on-surface-variant font-body mb-6">
          Quick translations for the terms that show up in the app.
        </p>
        <div className="bg-surface-container-low rounded-2xl p-6 md:p-8 border border-outline-variant/10 mb-16">
          <Term word="Wiki">
            A themed bucket for your cards. You might have a "Work" wiki, a "Cooking" wiki, and a
            "Family" wiki — each kept separate so things don't get mixed up.
          </Term>
          <Term word="Entry (or card)">
            A single piece of knowledge. One fact, one concept, one person. The smallest unit the
            memory works with.
          </Term>
          <Term word="Memory graph">
            The web of links between cards. Two cards that talk about related things get a line
            drawn between them.
          </Term>
          <Term word="Conflict">
            When two cards say opposite things ("the meeting is Monday" vs. "the meeting is
            Tuesday"). The system flags these so you can decide which is right.
          </Term>
          <Term word="Vibrancy">
            How "alive" a card is. Cards you use often stay bright and easy to find. Cards no one
            has touched in a long time fade — but they never disappear.
          </Term>
          <Term word="Recording vs. Retrieval Mode">
            <strong>Recording</strong> means the AI is allowed to add new cards as you chat.{" "}
            <strong>Retrieval</strong> means it can only read — useful when you want answers
            without growing the wiki.
          </Term>
        </div>

        {/* How to use it */}
        <h2 className="font-headline font-bold text-3xl text-primary mb-6">How to use it well</h2>
        <ol className="space-y-4 list-decimal list-outside ml-6 text-foreground/90 font-body leading-relaxed mb-16">
          <li>
            <strong>Pick a wiki before you chat.</strong> Whatever wiki is active is where new
            cards land. If you're talking about cooking, load your Cooking wiki first.
          </li>
          <li>
            <strong>Just talk normally.</strong> The AI extracts cards automatically. You don't
            need to write them yourself.
          </li>
          <li>
            <strong>Check the Suggestions tab now and then.</strong> When the system isn't sure
            where a card belongs, it asks you. A few seconds of cleanup keeps the library sharp.
          </li>
          <li>
            <strong>Resolve conflicts when they pop up.</strong> Two cards disagreeing? Pick the
            right one. The system learns from your choice.
          </li>
          <li>
            <strong>Let the sleep cycle do its thing.</strong> You don't have to organize — that's
            the system's job. Just keep adding knowledge and reviewing the prompts it surfaces.
          </li>
        </ol>

        <div className="text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-bold active:scale-95 transition-transform shadow-lg"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Wikis
          </Link>
        </div>
      </main>
    </div>
  );
};

export default MemoryGuide;

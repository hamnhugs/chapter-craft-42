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
            Back
          </Link>
          <span className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
            Guide
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12 pb-32">
        {/* Hero */}
        <div className="mb-12">
          <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
            How it works
          </span>
          <h1 className="font-headline font-bold text-5xl md:text-6xl text-primary tracking-tight mt-3 mb-4">
            How notes work
          </h1>
          <p className="text-on-surface-variant text-lg font-body leading-relaxed">
            Counsel keeps notes as you read and chat. Each note is short, says where it came from,
            and points back to the page. That's the whole system.
          </p>
        </div>

        {/* The Big Picture */}
        <section className="mb-12 bg-primary-container/40 rounded-2xl p-6 md:p-8">
          <h2 className="font-headline font-bold text-2xl text-on-primary-container mb-3">
            The big picture
          </h2>
          <p className="text-on-primary-container/90 font-body leading-relaxed">
            There are two things: your <strong>books</strong> and your <strong>notes</strong>. Notes
            live in <strong>notebooks</strong>, one per subject. The books are the real source; a note
            is a pointer into them with a sentence about why it matters to you.
          </p>
        </section>

        <h2 className="font-headline font-bold text-3xl text-primary mb-6">The parts</h2>
        <div className="space-y-5 mb-16">
          <Section icon="sticky_note_2" title="Notes" analogy="Margin notes that know their page">
            <p>
              When something worth keeping comes up — or when you say "remember this" — Counsel saves a
              note. Every note has a <strong>one-line summary</strong> and, when it came from a book, a
              link to the <strong>exact page</strong>.
            </p>
            <p>
              Open any note to see <em>why it's there</em>: who saved it, when, and the passages it
              points to. Edit it, or Forget it, any time.
            </p>
          </Section>

          <Section icon="menu_book" title="Notebooks" analogy="One per subject">
            <p>
              New notes go into the notebook that's open. Open two or three related notebooks
              together and Counsel connects ideas across them. Save a combination you use often as a
              <strong> saved set</strong>.
            </p>
          </Section>

          <Section icon="format_list_bulleted" title="How Counsel uses them" analogy="An index, not a pile">
            <p>
              Counsel always sees a one-line list of your notes. It opens a full note only when it
              needs one, and reads the actual book page before quoting it. That keeps answers quick and
              lets it cite pages like <em>(Moby-Dick, p. 214)</em> — tap a cited note under a reply to
              open it.
            </p>
            <p>
              If something you say or read disagrees with one of your notes, Counsel says so and shows
              you where the earlier note came from.
            </p>
          </Section>

          <Section icon="psychology_alt" title="Daily recall" analogy="Three questions a day">
            <p>
              Each day, <strong>Daily recall</strong> picks three notes. Answer from memory first, then
              check. Notes you remember come back less often; ones you miss come back tomorrow. Trying
              to remember before looking is what makes reading stick.
            </p>
          </Section>

          <Section icon="auto_fix_high" title="Tidy-up" analogy="Once a day, and undoable">
            <p>
              Once a day the app links related notes and writes summaries for notes that don't have
              one. You can see each tidy-up and <strong>undo</strong> it from the notebook menu under
              Recent tidy-ups.
            </p>
          </Section>

          <Section icon="visibility_off" title="Off the record" analogy="Read, but don't write">
            <p>
              Turn on <strong>Off the record</strong> in Counsel's tools when you don't want anything
              saved. Counsel can still use the notes you have; it just won't add new ones. Asking it to
              forget a note still works.
            </p>
          </Section>
        </div>

        {/* Glossary */}
        <h2 className="font-headline font-bold text-3xl text-primary mb-2">Words you'll see</h2>
        <div className="bg-surface-container-low rounded-2xl p-6 md:p-8 border border-outline-variant/10 mb-16">
          <Term word="Note">One saved idea, fact or quote, with a one-line summary and the page it points to.</Term>
          <Term word="Notebook">A collection of notes on one subject. New notes go to the one that's open.</Term>
          <Term word="Saved set">A few notebooks you open together in one tap.</Term>
          <Term word="Daily recall">Three notes a day to answer from memory.</Term>
          <Term word="Off the record">Counsel reads your notes but saves nothing new.</Term>
        </div>

        {/* How to use it */}
        <h2 className="font-headline font-bold text-3xl text-primary mb-6">Using it well</h2>
        <ol className="space-y-4 list-decimal list-outside ml-6 text-foreground/90 font-body leading-relaxed mb-16">
          <li>
            <strong>Open the right notebook.</strong> If you're reading about cooking, open your
            Cooking notebook so new notes land there.
          </li>
          <li>
            <strong>Just talk and read.</strong> Highlight what matters and chat about it. Say
            "remember this" for anything you want kept.
          </li>
          <li>
            <strong>Do your three a day.</strong> Daily recall takes about a minute.
          </li>
          <li>
            <strong>Fix what's wrong.</strong> If a note is off, tell Counsel — it corrects the note
            and keeps the old version in the note's history. You can also edit it yourself.
          </li>
        </ol>

        <div className="text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-bold active:scale-95 transition-transform shadow-lg"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to the app
          </Link>
        </div>
      </main>
    </div>
  );
};

export default MemoryGuide;

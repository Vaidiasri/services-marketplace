/**
 * The backdrop the glass panels blur. Without something coloured and uneven behind
 * them, backdrop-blur has nothing to work with and every card just looks grey.
 *
 * Fixed and aria-hidden: it is decoration, and a screen reader should never encounter
 * it. Pointer events are off so it can never intercept a click.
 */
export function Aurora() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-slate-50 dark:bg-slate-950"
    >
      <div
        className="aurora-blob left-[-10%] top-[-15%] h-[38rem] w-[38rem] bg-gradient-to-br from-indigo-300 via-sky-300 to-cyan-200 dark:from-indigo-600 dark:via-sky-700 dark:to-cyan-800"
        style={{ animationDelay: '0s' }}
      />
      <div
        className="aurora-blob right-[-12%] top-[10%] h-[32rem] w-[32rem] bg-gradient-to-br from-fuchsia-200 via-violet-300 to-indigo-200 dark:from-fuchsia-800 dark:via-violet-700 dark:to-indigo-800"
        style={{ animationDelay: '-7s' }}
      />
      <div
        className="aurora-blob bottom-[-18%] left-[25%] h-[34rem] w-[34rem] bg-gradient-to-br from-amber-100 via-rose-200 to-fuchsia-200 dark:from-amber-900 dark:via-rose-900 dark:to-fuchsia-900"
        style={{ animationDelay: '-14s' }}
      />
      {/* A faint grid keeps the gradient from reading as a blurry photo, and gives the
          blur something with structure to sample. */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.045)_1px,transparent_1px)] bg-[size:56px_56px] dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)]" />
    </div>
  );
}

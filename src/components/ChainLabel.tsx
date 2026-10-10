/** "Eagle-Eye 1 · step 2 of 4". Clicking it opens the chain overview tab. */
export function ChainLabel({ label, onOpen }: { label: string; onOpen?: (() => void) | null }) {
  if (!onOpen) return <span className="chain-label">{label}</span>;
  return (
    <button
      type="button"
      className="chain-label"
      title="Open chain overview"
      onClick={onOpen}
    >
      {label}
    </button>
  );
}

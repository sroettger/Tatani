import { Furigana } from "@/components/Furigana";
import { splitSentenceWithHighlight } from "@/lib/srs";
import { cn } from "@/lib/utils";

export function ContextSentence({
  sentence,
  targetWord,
  showFurigana = false,
  hasRuby = true,
  className,
}: {
  sentence: string;
  targetWord: string;
  showFurigana?: boolean;
  hasRuby?: boolean;
  className?: string;
}) {
  const segments = splitSentenceWithHighlight(sentence, targetWord);
  return (
    <p className={cn("leading-relaxed", hasRuby && "font-jp", className)}>
      {segments.map((seg, i) => {
        const inner = hasRuby ? (
          <Furigana text={seg.text} show={showFurigana} />
        ) : (
          <span>{seg.text}</span>
        );
        if (!seg.highlighted) {
          return <span key={i}>{inner}</span>;
        }
        return (
          <mark
            key={i}
            className="bg-primary/18 text-foreground font-semibold px-1 py-0.5 rounded border-b-2 border-primary/70"
          >
            {inner}
          </mark>
        );
      })}
    </p>
  );
}

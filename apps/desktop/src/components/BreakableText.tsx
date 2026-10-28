import { Fragment } from "react";

const maxUnbrokenCharacters = 48;

export function BreakableText({ value }: { value: string }) {
  return (
    <>
      {value.split(/(\s+)/u).map((part, partIndex) => {
        if (!part || /^\s+$/u.test(part)) {
          return <Fragment key={`${partIndex}-${part}`}>{part}</Fragment>;
        }
        const characters = Array.from(part);
        const chunks: string[] = [];
        for (
          let offset = 0;
          offset < characters.length;
          offset += maxUnbrokenCharacters
        ) {
          chunks.push(
            characters.slice(offset, offset + maxUnbrokenCharacters).join(""),
          );
        }
        return chunks.map((chunk, chunkIndex) => (
          <Fragment key={`${partIndex}-${chunkIndex}`}>
            {chunkIndex > 0 ? <wbr /> : null}
            {chunk}
          </Fragment>
        ));
      })}
    </>
  );
}

export function rewriteRunOutput(primaryRoot: string, replicaRoot: string) {
  if (!primaryRoot) throw new Error("A primary project root is required.");
  const source = Buffer.from(primaryRoot);
  const destination = Buffer.from(replicaRoot);
  let pending: Buffer = Buffer.alloc(0);
  let previous = 0;
  const pathByte = (byte: number | undefined) =>
    byte !== undefined && (byte >= 128 || /[A-Za-z0-9_./\\~+-]/.test(String.fromCharCode(byte)));
  const drain = (final: boolean) => {
    const pieces: Buffer[] = [];
    let offset = 0;
    let start = 0;
    while (offset < pending.length - (final ? 0 : source.length)) {
      const next = pending[offset + source.length];
      if (
        !pathByte(previous) &&
        pending.subarray(offset, offset + source.length).equals(source) &&
        (next === 47 || next === 92 || !pathByte(next))
      ) {
        pieces.push(pending.subarray(start, offset), destination);
        offset += source.length;
        start = offset;
      } else {
        offset++;
      }
      previous = pending[offset - 1]!;
    }
    pieces.push(pending.subarray(start, offset));
    pending = pending.subarray(offset);
    return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces);
  };
  return {
    write(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      return drain(false);
    },
    end() {
      return drain(true);
    },
  };
}

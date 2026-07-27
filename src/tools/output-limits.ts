const UTF8_ENCODER = new TextEncoder();

export interface LimitedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
  shownBytes: number;
}

function takeUtf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) {
    return '';
  }

  let consumedBytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (consumedBytes + characterBytes > maximumBytes) {
      break;
    }
    consumedBytes += characterBytes;
    result += character;
  }
  return result;
}

function takeUtf8Suffix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) {
    return '';
  }

  const characters = Array.from(value);
  let consumedBytes = 0;
  let startIndex = characters.length;
  while (startIndex > 0) {
    const characterBytes = UTF8_ENCODER.encode(characters[startIndex - 1]).byteLength;
    if (consumedBytes + characterBytes > maximumBytes) {
      break;
    }
    consumedBytes += characterBytes;
    startIndex -= 1;
  }
  return characters.slice(startIndex).join('');
}

export function limitUtf8Head(
  value: string,
  maximumBytes: number,
  marker = '\n\n[Output truncated]'
): LimitedText {
  const normalizedMaximumBytes = Math.max(0, Math.floor(maximumBytes));
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= normalizedMaximumBytes) {
    return {
      text: value,
      truncated: false,
      originalBytes,
      shownBytes: originalBytes
    };
  }

  const fittedMarker = takeUtf8Prefix(marker, normalizedMaximumBytes);
  const markerBytes = Buffer.byteLength(fittedMarker, 'utf8');
  const prefix = takeUtf8Prefix(
    value,
    Math.max(0, normalizedMaximumBytes - markerBytes)
  );
  const text = `${prefix}${fittedMarker}`;
  return {
    text,
    truncated: true,
    originalBytes,
    shownBytes: Buffer.byteLength(text, 'utf8')
  };
}

export function limitUtf8HeadTail(
  value: string,
  maximumBytes: number,
  marker = '\n\n[Output truncated: middle omitted]\n\n'
): LimitedText {
  const normalizedMaximumBytes = Math.max(0, Math.floor(maximumBytes));
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= normalizedMaximumBytes) {
    return {
      text: value,
      truncated: false,
      originalBytes,
      shownBytes: originalBytes
    };
  }

  const fittedMarker = takeUtf8Prefix(marker, normalizedMaximumBytes);
  const markerBytes = Buffer.byteLength(fittedMarker, 'utf8');
  const availableBytes = Math.max(0, normalizedMaximumBytes - markerBytes);
  const headBytes = Math.ceil(availableBytes / 2);
  const tailBytes = Math.floor(availableBytes / 2);
  const text = `${takeUtf8Prefix(value, headBytes)}${fittedMarker}${takeUtf8Suffix(value, tailBytes)}`;
  return {
    text,
    truncated: true,
    originalBytes,
    shownBytes: Buffer.byteLength(text, 'utf8')
  };
}

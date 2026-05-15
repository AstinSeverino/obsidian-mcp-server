import { pipeline } from "@huggingface/transformers";

let extractor: any = null;

async function getExtractor(): Promise<any> {
  if (!extractor) {
    extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "fp32" } as any
    );
  }
  return extractor;
}

export async function embed(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data);
}

export function chunkByHeadings(
  content: string,
  maxTokens = 512
): string[] {
  const headingRegex = /^#{1,6}\s+.+$/gm;
  const sections: string[] = [];
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const section = content.slice(lastIndex, match.index).trim();
      if (section) sections.push(section);
    }
    lastIndex = match.index;
  }

  if (lastIndex < content.length) {
    const section = content.slice(lastIndex).trim();
    if (section) sections.push(section);
  }

  if (sections.length === 0 && content.trim()) {
    sections.push(content.trim());
  }

  const chunks: string[] = [];
  for (const section of sections) {
    const approxTokens = section.split(/\s+/).length;
    if (approxTokens <= maxTokens) {
      chunks.push(section);
    } else {
      const words = section.split(/\s+/);
      for (let i = 0; i < words.length; i += maxTokens - 50) {
        const chunk = words.slice(i, i + maxTokens).join(" ");
        if (chunk.trim()) chunks.push(chunk);
      }
    }
  }

  return chunks;
}

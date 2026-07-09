import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import type PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import { config } from '../config/index.js';
import { ClaudeTimeoutError } from '../utils/errors.js';

const anthropic = new Anthropic({ apiKey: config.claudeApiKey });

const SPEC_DEADLINE_MS = 52_000;

export interface GeneratedFile {
    buffer: Buffer;
    filename: string;
    mimeType: string;
}

export type DocFormat = 'docx' | 'pdf' | 'md' | 'pptx' | 'xlsx';

export interface DocSection {
    heading?: string;
    paragraphs?: string[];
    bullets?: string[];
}

export interface DocSlide {
    title?: string;
    bullets?: string[];
}

export interface DocSheet {
    name?: string;
    rows?: string[][];
}

export interface DocSpec {
    format: DocFormat;
    filename: string;
    title: string;
    sections?: DocSection[];
    slides?: DocSlide[];
    sheets?: DocSheet[];
}

export class SpecGenerationError extends Error {}
export class RenderError extends Error {}

const DOC_FORMATS: DocFormat[] = ['docx', 'pdf', 'md', 'pptx', 'xlsx'];

const MIME_TYPES: Record<DocFormat, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
    md: 'text/markdown',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const specSystemPrompt = `You convert a student's request into a document specification. Output ONLY a JSON object, with no code fences and no commentary, of this exact shape:
{"format":"docx|pdf|md|pptx|xlsx","filename":"descriptive-name.ext","title":"Document title","sections":[{"heading":"string","paragraphs":["string"],"bullets":["string"]}],"slides":[{"title":"string","bullets":["string"]}],"sheets":[{"name":"string","rows":[["cell"]]}]}

Rules:
- Use "sections" for docx, pdf and md. Use "slides" for pptx. Use "sheets" for xlsx. Include only the field that matches the chosen format.
- If the user names a format, honor it. Otherwise infer: notes or essays use docx, slide requests use pptx, tables or data use xlsx, quick references use md, formal or printable documents use pdf.
- Write complete, substantive content. The document must fully answer the request on its own; never output placeholders like "add content here".
- The filename extension must match the format.`;

function withDeadline<T>(p: Promise<T>, msLeft: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ClaudeTimeoutError()), Math.max(0, msLeft));
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type SpecMessage = { role: 'user' | 'assistant'; content: string };

async function callSpecModel(messages: SpecMessage[]): Promise<string> {
    const params = {
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system: specSystemPrompt,
        messages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    const response = await withDeadline(anthropic.messages.create(params), SPEC_DEADLINE_MS);
    return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
}

function tryParseSpec(raw: string): DocSpec | null {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    const obj = parsed as Partial<DocSpec>;
    if (!obj || typeof obj !== 'object') return null;
    if (!DOC_FORMATS.includes(obj.format as DocFormat)) return null;

    return {
        format: obj.format as DocFormat,
        filename: typeof obj.filename === 'string' ? obj.filename : 'document',
        title: typeof obj.title === 'string' && obj.title.trim() ? obj.title : 'Document',
        sections: Array.isArray(obj.sections) ? obj.sections : [],
        slides: Array.isArray(obj.slides) ? obj.slides : [],
        sheets: Array.isArray(obj.sheets) ? obj.sheets : [],
    };
}

export async function generateDocSpec(request: string): Promise<DocSpec> {
    let raw: string;
    try {
        raw = await callSpecModel([{ role: 'user', content: request }]);
    } catch (error) {
        throw new SpecGenerationError((error as Error).message);
    }

    let spec = tryParseSpec(raw);
    if (!spec) {
        let retryRaw: string;
        try {
            retryRaw = await callSpecModel([
                { role: 'user', content: request },
                { role: 'assistant', content: raw || '(empty)' },
                {
                    role: 'user',
                    content:
                        'Output valid JSON only, matching the required shape exactly. No code fences, no commentary.',
                },
            ]);
        } catch (error) {
            throw new SpecGenerationError((error as Error).message);
        }
        spec = tryParseSpec(retryRaw);
    }

    if (!spec) throw new SpecGenerationError('Model did not return a valid document spec');
    return spec;
}

function sanitizeBaseName(name: string): string {
    const base = (name || 'document')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[^\w.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return base || 'document';
}

function fileName(spec: DocSpec, ext: DocFormat): string {
    return `${sanitizeBaseName(spec.filename)}.${ext}`;
}

function toLatin1(text: string): string {
    return text
        .normalize('NFKC')
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...')
        .replace(/[^\x0A\x20-\xFF]/g, '');
}

export async function renderDocx(spec: DocSpec): Promise<GeneratedFile> {
    const children: Paragraph[] = [new Paragraph({ text: spec.title, heading: HeadingLevel.HEADING_1 })];
    for (const s of spec.sections ?? []) {
        if (s.heading) children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_2 }));
        for (const p of s.paragraphs ?? []) children.push(new Paragraph({ text: p }));
        for (const b of s.bullets ?? []) children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
    }
    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    return { buffer: Buffer.from(buffer), filename: fileName(spec, 'docx'), mimeType: MIME_TYPES.docx };
}

function wrapPdfLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [''];
}

export async function renderPdf(spec: DocSpec): Promise<GeneratedFile> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 50;
    const textWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const draw = (text: string, f: PDFFont, size: number, gapAfter: number): void => {
        for (const line of wrapPdfLine(toLatin1(text), f, size, textWidth)) {
            if (y < margin + size) {
                page = doc.addPage([pageWidth, pageHeight]);
                y = pageHeight - margin;
            }
            page.drawText(line, { x: margin, y, size, font: f });
            y -= size * 1.4;
        }
        y -= gapAfter;
    };

    draw(spec.title, bold, 18, 10);
    for (const s of spec.sections ?? []) {
        if (s.heading) draw(s.heading, bold, 14, 4);
        for (const p of s.paragraphs ?? []) draw(p, font, 11, 6);
        for (const b of s.bullets ?? []) draw(`- ${b}`, font, 11, 2);
    }

    const bytes = await doc.save();
    return { buffer: Buffer.from(bytes), filename: fileName(spec, 'pdf'), mimeType: MIME_TYPES.pdf };
}

export function renderMd(spec: DocSpec): GeneratedFile {
    const lines: string[] = [`# ${spec.title}`, ''];
    for (const s of spec.sections ?? []) {
        if (s.heading) lines.push(`## ${s.heading}`, '');
        for (const p of s.paragraphs ?? []) lines.push(p, '');
        for (const b of s.bullets ?? []) lines.push(`- ${b}`);
        if (s.bullets?.length) lines.push('');
    }
    return {
        buffer: Buffer.from(lines.join('\n'), 'utf-8'),
        filename: fileName(spec, 'md'),
        mimeType: MIME_TYPES.md,
    };
}

// pptxgenjs's "import" entry (dist/pptxgen.es.js) cannot be loaded by Node's
// native ESM loader (the package is not type:module), which crashes the whole
// serverless function on cold start. Force the working CJS build instead.
const nodeRequire = createRequire(import.meta.url);
const pptxModule = nodeRequire('pptxgenjs') as { default?: unknown };
const PptxCtor = (pptxModule.default ?? pptxModule) as new () => PptxGenJS;

export async function renderPptx(spec: DocSpec): Promise<GeneratedFile> {
    const pptx = new PptxCtor();
    const slides = spec.slides?.length ? spec.slides : [{ title: spec.title, bullets: [] as string[] }];
    for (const s of slides) {
        const slide = pptx.addSlide();
        slide.addText(s.title ?? spec.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });
        if (s.bullets?.length) {
            slide.addText(
                s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
                { x: 0.5, y: 1.4, w: 9, h: 4.5, fontSize: 16 }
            );
        }
    }
    const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
    return { buffer, filename: fileName(spec, 'pptx'), mimeType: MIME_TYPES.pptx };
}

export async function renderXlsx(spec: DocSpec): Promise<GeneratedFile> {
    const workbook = new ExcelJS.Workbook();
    const sheets = spec.sheets?.length ? spec.sheets : [{ name: 'Sheet1', rows: [[spec.title]] }];
    for (const s of sheets) {
        const name = (s.name ?? 'Sheet').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet';
        const ws = workbook.addWorksheet(name);
        ws.addRows(s.rows ?? []);
    }
    const data = await workbook.xlsx.writeBuffer();
    return {
        buffer: Buffer.from(data as ArrayBuffer),
        filename: fileName(spec, 'xlsx'),
        mimeType: MIME_TYPES.xlsx,
    };
}

export async function createDocument(request: string): Promise<GeneratedFile> {
    const spec = await generateDocSpec(request);
    try {
        switch (spec.format) {
            case 'docx':
                return await renderDocx(spec);
            case 'pdf':
                return await renderPdf(spec);
            case 'md':
                return renderMd(spec);
            case 'pptx':
                return await renderPptx(spec);
            case 'xlsx':
                return await renderXlsx(spec);
        }
    } catch (error) {
        throw new RenderError((error as Error).message);
    }
    throw new RenderError(`Unsupported format: ${String(spec.format)}`);
}

/**
 * Convert markdown-formatted text to plain text for WeChat delivery.
 *
 * WeChat doesn't render markdown, so AI model responses need to be
 * stripped of markdown syntax before sending.
 *
 * Preserves newlines and content structure; strips formatting syntax.
 */
export declare function stripMarkdown(text: string): string;
//# sourceMappingURL=markdown.d.ts.map
export function plain<T>(doc: unknown): T {
    const { _id, __v, ...rest } = doc as Record<string, unknown>;
    void __v;
    return (_id === undefined ? rest : { id: String(_id), ...rest }) as T;
}

export function plainOrNull<T>(doc: unknown): T | null {
    return doc ? plain<T>(doc) : null;
}

export function plainList<T>(docs: unknown[]): T[] {
    return docs.map((d) => plain<T>(d));
}

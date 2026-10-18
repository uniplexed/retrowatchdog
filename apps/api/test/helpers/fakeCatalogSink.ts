import type { CatalogItemUpsert, CatalogSink } from "../../src/adapters/types.js";

export class FakeCatalogSink implements CatalogSink {
  batches: CatalogItemUpsert[][] = [];
  async upsert(items: CatalogItemUpsert[]): Promise<void> {
    this.batches.push(items);
  }
  get all(): CatalogItemUpsert[] {
    return this.batches.flat();
  }
}

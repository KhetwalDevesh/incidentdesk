import type { TenantId } from "../../domain/shared/identity";

// The twin of the shared daily AI budget: each in-memory draft store registers how many of
// a tenant's drafts it holds since a time, and the budget adds them up.
export class InMemoryDraftBudget {
	private readonly counters: ((tenantId: TenantId, since: Date) => number)[] = [];

	register(counter: (tenantId: TenantId, since: Date) => number): void {
		this.counters.push(counter);
	}

	usedSinceSync(tenantId: TenantId, since: Date): number {
		return this.counters.reduce((total, counter) => total + counter(tenantId, since), 0);
	}
}

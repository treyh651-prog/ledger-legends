import { useQuery } from "@tanstack/react-query";
import type { TransactionPage, TransactionQuery } from "@shared/api";
import { api, toQuery } from "./http";

export const transactionKeys = {
  page: (clientId: string, q: Partial<TransactionQuery>) => ["api", "firm", "clients", clientId, "transactions", q] as const,
};

export function useTransactions(clientId: string | null, q: Partial<TransactionQuery> = {}) {
  return useQuery({
    queryKey: transactionKeys.page(clientId ?? "none", q),
    queryFn: () =>
      api<TransactionPage>(
        "GET",
        `/api/firm/clients/${clientId}/transactions${toQuery(q as Record<string, string | number | boolean | undefined>)}`,
      ),
    enabled: !!clientId,
  });
}

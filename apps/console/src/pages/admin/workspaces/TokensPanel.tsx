// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Runtime token mint/revoke UI. The plaintext token is shown once and never stored. */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, RefreshCw, ShieldOff } from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  Pill,
  Skeleton,
  SmallButton,
  TableShell,
  Td,
  Th,
  Thead,
  Tr,
  inputClassName,
  selectClassName,
} from '../../../components/ui';
import { Modal, ModalError } from '../../../components/Modal';
import { toast } from '../../../stores/toastStore';
import {
  tokenStatus,
  type WorkspaceCatalog,
  type WorkspaceProduct,
  type WorkspaceTokenMetadata,
} from '../../../lib/workspaces';
import { fetchTokens, mintToken, revokeToken } from '../../../lib/workspacesApi';
import { formatDate } from '../../../lib/format';

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message = value?.message || 'The capability service refused the request.';
  return value?.code ? `${message} (${value.code})` : message;
}

export function TokensPanel({
  product,
  catalog,
  onChanged,
}: {
  product: WorkspaceProduct;
  catalog: WorkspaceCatalog | null;
  onChanged: () => void;
}) {
  const tokens = useQuery({ queryKey: ['workspace-tokens'], queryFn: fetchTokens, retry: false });
  const tokenMaxDays = catalog?.limits.tokenMaxDays ?? 365;
  const [mintProduct, setMintProduct] = useState<WorkspaceProduct>(product);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(String(catalog?.limits.tokenDefaultDays ?? 90));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<WorkspaceTokenMetadata | null>(null);

  useEffect(() => {
    setMintProduct(product);
  }, [product]);

  useEffect(() => {
    setExpiresInDays(String(catalog?.limits.tokenDefaultDays ?? 90));
  }, [catalog]);

  const mint = async () => {
    if (busy) return;
    setError(null);
    if (!name.trim()) {
      setError('A token name is required.');
      return;
    }
    const days = expiresInDays.trim() ? Number(expiresInDays) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > tokenMaxDays)) {
      setError(`Expiry must be between 1 and ${tokenMaxDays} days.`);
      return;
    }
    setBusy('mint');
    try {
      const result = await mintToken({
        product: mintProduct,
        name: name.trim(),
        ...(days !== undefined ? { expiresInDays: Math.floor(days) } : {}),
      });
      setIssued(result.token);
      setName('');
      await tokens.refetch();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const copyToken = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      toast('Token copied. Store it in the server environment now.');
    } catch {
      toast('Clipboard access was refused. Select the token text manually.', 'warn');
    }
  };

  const confirmRevoke = async () => {
    if (!revoking || busy) return;
    setBusy(revoking.id);
    try {
      await revokeToken(revoking.id);
      toast('Runtime token revoked.');
      setRevoking(null);
      await tokens.refetch();
      onChanged();
    } catch (failure) {
      toast(errorText(failure), 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          eyebrow="Runtime credentials"
          title="Workspace tokens"
          description="Tokens authorize reading published layouts from GET /runtime/:product. They never authorize product data mutations, impersonation or management operations."
          actions={
            <Button variant="ghost" onClick={() => void tokens.refetch()} disabled={tokens.isFetching}>
              <RefreshCw size={14} /> Refresh
            </Button>
          }
        />
        <div className="grid gap-3 px-5 py-4 md:grid-cols-[160px_minmax(0,1fr)_150px_auto] md:items-end">
          <Field label="Product">
            <select
              className={selectClassName}
              value={mintProduct}
              onChange={(event) => setMintProduct(event.target.value as WorkspaceProduct)}
            >
              <option value="city">city</option>
              <option value="sos">sos</option>
            </select>
          </Field>
          <Field label="Name" required>
            <input
              className={inputClassName}
              value={name}
              maxLength={120}
              placeholder="City edge deploy"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Expires in days">
            <input
              className={inputClassName}
              type="number"
              min={1}
              max={tokenMaxDays}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
            />
          </Field>
          <Button variant="primary" onClick={() => void mint()} disabled={Boolean(busy)}>
            <KeyRound size={14} /> {busy === 'mint' ? 'Minting…' : 'Mint token'}
          </Button>
        </div>
        <div className="px-5 pb-4">
          <ModalError message={error} />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Only a hash is persisted. Copy the plaintext token when the one-time dialog appears; it cannot be shown
            again. Never put a token in a URL, plugin bundle, source file or log.
          </p>
        </div>
      </Card>

      {tokens.isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : tokens.isError ? (
        <Card className="p-6">
          <ModalError message={errorText(tokens.error)} />
          <Button className="mt-3" variant="primary" onClick={() => void tokens.refetch()}>Retry</Button>
        </Card>
      ) : (tokens.data ?? []).length === 0 ? (
        <Card className="p-6">
          <EmptyState icon={<KeyRound size={20} />} title="No runtime tokens" message="Mint a scoped token for a Tier-3 deployment." />
        </Card>
      ) : (
        <Card>
          <TableShell>
            <Thead>
              <Th>Name</Th>
              <Th>Product</Th>
              <Th>Prefix</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th>Expires</Th>
              <Th>Last used</Th>
              <Th><span className="sr-only">Actions</span></Th>
            </Thead>
            <tbody>
              {(tokens.data ?? []).map((token) => {
                const status = tokenStatus(token);
                return (
                  <Tr key={token.id}>
                    <Td className="font-medium">{token.name}</Td>
                    <Td><Pill tone="neutral">{token.product}</Pill></Td>
                    <Td className="font-mono text-xs">{token.tokenPrefix}…</Td>
                    <Td>
                      <Pill tone={status === 'active' ? 'ok' : status === 'expired' ? 'warn' : 'bad'}>{status}</Pill>
                    </Td>
                    <Td className="text-xs text-slate-500">{formatDate(token.createdAt)}</Td>
                    <Td className="text-xs text-slate-500">{formatDate(token.expiresAt)}</Td>
                    <Td className="text-xs text-slate-500">{token.lastUsedAt ? formatDate(token.lastUsedAt) : '—'}</Td>
                    <Td>
                      <SmallButton
                        type="button"
                        variant="danger"
                        onClick={() => setRevoking(token)}
                        disabled={status === 'revoked' || Boolean(busy)}
                      >
                        <ShieldOff size={13} /> Revoke
                      </SmallButton>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableShell>
        </Card>
      )}

      <Modal
        open={Boolean(issued)}
        onClose={() => setIssued(null)}
        title="Copy this token now"
        footer={
          <>
            <Button variant="ghost" onClick={() => void copyToken()}>
              <Copy size={14} /> Copy token
            </Button>
            <Button variant="primary" onClick={() => setIssued(null)}>I stored it</Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This is the only time the plaintext token is shown. Closing the dialog discards it from this browser.
          </p>
          <code className="block select-all break-all rounded-xl bg-slate-950 px-3 py-3 font-mono text-xs text-emerald-200">
            {issued}
          </code>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Do not paste this token into chat, source code, URLs, plugin bundles, audit fields or logs.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revoke runtime token"
        message={
          revoking
            ? `Revoke ${revoking.name} (${revoking.tokenPrefix}…)? Tier-3 readers using it will start receiving 401.`
            : undefined
        }
        label="Revoke"
        danger
        busy={Boolean(busy)}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void confirmRevoke()}
      />
    </div>
  );
}

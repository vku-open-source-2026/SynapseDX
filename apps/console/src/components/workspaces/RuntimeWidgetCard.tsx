// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Runtime widget card: loads DX widget data and executes bound forms in DX. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeWidget } from './SafeWidget';
import { executeFormWidget, fetchWidgetData } from '../../lib/workspacesApi';
import { formReasonMessage, type RuntimeWidget } from '../../lib/workspaces';

export function RuntimeWidgetCard({
  installedId,
  widget,
  cacheScope,
  formUnavailableReason,
}: {
  installedId: string;
  widget: RuntimeWidget;
  cacheScope: string;
  formUnavailableReason?: string | null;
}) {
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const needsData = widget.type === 'metric' || widget.type === 'table';

  const query = useQuery({
    queryKey: ['workspace-widget', cacheScope, installedId, widget.id],
    queryFn: () => fetchWidgetData(installedId, widget),
    enabled: needsData,
    retry: false,
  });

  const submit = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      await executeFormWidget(installedId, widget.id, values);
      await queryClient.invalidateQueries({ queryKey: ['workspace-widget', cacheScope, installedId] });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeWidget
      widget={widget}
      data={query.data}
      dataLoading={query.isLoading}
      dataError={query.error ? (query.error as Error).message : null}
      formUnavailableReason={
        widget.canSubmit
          ? null
          : formReasonMessage(widget.canSubmitReason, formUnavailableReason)
      }
      onFormSubmit={widget.type === 'form' ? submit : undefined}
      formBusy={submitting}
    />
  );
}

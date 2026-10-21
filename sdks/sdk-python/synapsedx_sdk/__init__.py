# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""synapsedx Python SDK — gateway client for the SynapseDX platform.

The SDK is split per service; use the namespace that matches the service you
talk to:

======================  =============================================
``client.iam``          auth, orgs/accounts/users, roles, policies,
                        API keys, credentials, service accounts
``client.workflow``     workflow templates, CRUD/lifecycle, executions,
                        test runs
``client.lds``          LDS datasources, attributes, records, NGSI-LD
                        entities, licenses
``client.base``         SynapseBase collections/documents, queries,
                        batches, counters, change feed, object mapping
``client.faststore``    Synapse Faststore cache/KV, hashes, lists, sets,
                        sorted sets, locks
``client.queue``        SynapseQueue publish/consume/ack, dead letters
======================  =============================================

The old flat methods on :class:`SynapseDXClient` still work but are deprecated:
each one emits a ``DeprecationWarning`` and forwards to the namespaced call
(e.g. ``client.list_templates()`` -> ``client.workflow.list_templates()``).

Example::

    from synapsedx_sdk import SynapseDXClient

    client = SynapseDXClient("http://localhost:8080", token=jwt)
    parks = client.base.collection("parks", model=Park, mapping={"name": "profile.name"})
    parks.create(Park(name="Central"))
    result = client.queue.publish("emails", {"to": "a@b.c"})
"""

from __future__ import annotations

import warnings
from typing import Any

from ._http import UNSET, HttpClient, SynapseDXError
from .base import (
    BaseCollection,
    BaseService,
    QueryResult,
    data_to_object,
    normalize_mapping,
    object_to_data,
)
from .faststore import FaststoreService
from .iam import IamService
from .lds import LdsService
from .queue import QueueService
from .inference import InferenceService
from .workflow import WorkflowService, trigger_webhook, unwrap_executions

__all__ = [
    "UNSET",
    "BaseCollection",
    "BaseService",
    "FaststoreService",
    "IamService",
    "InferenceService",
    "LdsService",
    "QueryResult",
    "QueueService",
    "SynapseDXClient",
    "SynapseDXError",
    "WorkflowService",
    "data_to_object",
    "normalize_mapping",
    "object_to_data",
    "trigger_webhook",
    "unwrap_executions",
]


class SynapseDXClient:
    """One client, one HTTP layer, six service namespaces.

    ``base_url`` points at the gateway (``http://localhost:8080``) or a single
    service origin. ``tenant`` is sent as ``x-synapsedx-tenant`` and is only
    required by platform callers of faststore/queue.
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        api_key: str | None = None,
        timeout: int = 15,
        tenant: str | None = None,
    ) -> None:
        self._http = HttpClient(
            base_url, token=token, api_key=api_key, tenant=tenant, timeout=timeout
        )
        self.iam = IamService(self._http)
        self.workflow = WorkflowService(self._http)
        self.lds = LdsService(self._http)
        self.base = BaseService(self._http)
        self.faststore = FaststoreService(self._http)
        self.queue = QueueService(self._http)
        self.inference = InferenceService(self._http)

    # ---- transport knobs (also mirrored by JS setToken/setApiKey and Go) ----
    @property
    def base_url(self) -> str:
        return self._http.base_url

    @base_url.setter
    def base_url(self, value: str) -> None:
        self._http.base_url = value.rstrip("/")

    @property
    def token(self) -> str | None:
        return self._http.token

    @token.setter
    def token(self, value: str | None) -> None:
        self._http.token = value

    @property
    def api_key(self) -> str | None:
        return self._http.api_key

    @api_key.setter
    def api_key(self, value: str | None) -> None:
        self._http.api_key = value

    @property
    def tenant(self) -> str | None:
        return self._http.tenant

    @tenant.setter
    def tenant(self, value: str | None) -> None:
        self._http.tenant = value

    @property
    def timeout(self) -> int:
        return self._http.timeout

    @timeout.setter
    def timeout(self, value: int) -> None:
        self._http.timeout = value

    def set_token(self, token: str) -> None:
        """Set/replace the Bearer JWT (mirrors JS setToken / Go SetToken)."""
        self.token = token

    def set_api_key(self, api_key: str) -> None:
        """Set/replace the X-API-Key (mirrors JS setApiKey / Go SetAPIKey)."""
        self.api_key = api_key

    def call(self, method: str, path: str, body: Any | None = None) -> Any:
        """Generic escape hatch (forward-compat with endpoints added after this SDK).

        method is e.g. 'GET'/'POST'/'PUT'/'DELETE'; path must start with '/'.
        """
        verb = (method or "GET").upper()
        if not path.startswith("/"):
            path = "/" + path
        if verb in ("GET", "HEAD"):
            return self._http.request(verb, path)
        return self._http.request(verb, path, body)


# ---------------------------------------------------------------------------
# deprecated flat wrappers (legacy merged API)
# ---------------------------------------------------------------------------

_IAM_METHODS = (
    "login",
    "refresh",
    "logout",
    "logout_all",
    "verify",
    "me",
    "oidc_config",
    "oidc_start",
    "oidc_callback",
    "list_orgs",
    "create_org",
    "create_account",
    "list_accounts",
    "create_user",
    "list_users",
    "user_policies",
    "authorize",
    "attach_policy",
    "detach_policy",
    "role_policies",
    "assign_role",
    "unassign_role",
    "user_roles",
    "simulate",
    "list_audit",
    "create_api_key",
    "revoke_api_key",
    "list_api_keys",
    "verify_api_key",
    "create_credential",
    "list_credentials",
    "get_credential",
    "delete_credential",
    "rotate_credential",
    "create_service_account",
    "list_service_accounts",
    "list_roles",
    "create_role",
    "delete_role",
    "list_policies",
    "create_policy",
    "delete_policy",
    "service_account_token",
)

_WORKFLOW_METHODS = (
    "list_templates",
    "get_template",
    "get_workflow",
    "activate_workflow",
    "deactivate_workflow",
    "execute_workflow",
    "list_workflows",
    "create_workflow_from_template",
    "create_workflow",
    "update_workflow",
    "delete_workflow",
    "list_executions",
    "get_execution",
    "test_run",
)

_LDS_METHODS = {
    "list_lds_licenses": "list_licenses",
    "list_lds_datasources": "list_datasources",
    "create_lds_datasource": "create_datasource",
    "get_lds_datasource": "get_datasource",
    "update_lds_datasource": "update_datasource",
    "delete_lds_datasource": "delete_datasource",
    "get_lds_datasource_attributes": "get_datasource_attributes",
    "set_lds_datasource_attributes": "set_datasource_attributes",
    "ingest_lds_records": "ingest_records",
    "list_lds_entities": "list_entities",
    "get_lds_entity": "get_entity",
    "get_lds_datasource_stats": "get_datasource_stats",
}


def _deprecated(service: str, legacy: str, target: str):
    replacement = f"client.{service}.{target}()"

    def wrapper(self: SynapseDXClient, *args: Any, **kwargs: Any) -> Any:
        warnings.warn(
            f"SynapseDXClient.{legacy}() is deprecated; use {replacement} instead",
            DeprecationWarning,
            stacklevel=2,
        )
        return getattr(getattr(self, service), target)(*args, **kwargs)

    wrapper.__name__ = legacy
    wrapper.__qualname__ = f"SynapseDXClient.{legacy}"
    wrapper.__doc__ = f"Deprecated alias for ``{replacement}``."
    return wrapper


for _name in _IAM_METHODS:
    setattr(SynapseDXClient, _name, _deprecated("iam", _name, _name))
for _name in _WORKFLOW_METHODS:
    setattr(SynapseDXClient, _name, _deprecated("workflow", _name, _name))
for _legacy, _target in _LDS_METHODS.items():
    setattr(SynapseDXClient, _legacy, _deprecated("lds", _legacy, _target))

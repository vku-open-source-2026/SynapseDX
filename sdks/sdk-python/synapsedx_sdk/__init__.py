# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Compatibility shim for the SynapseDX -> SynapseOne rebrand.

``synapsedx_sdk`` is deprecated; import ``synapseone_sdk`` instead. Everything
here is re-exported from the canonical package, including the legacy
``SynapseDXClient`` / ``SynapseDXError`` aliases.
"""

from synapseone_sdk import *  # noqa: F401,F403
from synapseone_sdk import __all__ as __all__  # noqa: F401

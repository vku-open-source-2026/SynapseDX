/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
/* Runtime config — replaced at container start (see docker-entrypoint.sh).
   Local dev default points at the gateway on localhost. */
window.SYNAPSEONE_CONFIG = {
  BASE_URL: 'http://localhost:8080',
  APP_URL: 'http://localhost:3000',
};

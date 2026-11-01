# `@synapsedx/capabilities`

The small, transport-only SDK for SynapseDX Tier 2. SynapseCity uses this
client for every Tier-2 call; it never imports the SynapseOne SDK directly.

```ts
import { CapabilitiesClient } from '@synapsedx/capabilities';

const dx = new CapabilitiesClient({
  baseUrl: 'https://synapsedx.sbs',
  apiKey: process.env.SYNAPSEDX_API_KEY,
});
const dataset = await dx.datasets.create({
  slug: 'city-assets', name: 'City assets', entityType: 'CityAsset',
  license: 'CC-BY-4.0', public: true,
});
await dx.records.create(dataset.id, { assetId: 'asset-1', name: 'Central Park' });
```

The package is intentionally free of domain models. Domain validation belongs
in SynapseCity or another Tier-3 product.

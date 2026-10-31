/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Built-in license catalog for SynapseLDS datasets. Users pick one per
 * datasource; the SPDX id + canonical URL surface on every NGSI-LD export
 * (X-LDS-License header + Link rel="license"), so downstream reusers always
 * know the terms. Open-data licenses are marked `openData: true`.
 */

export interface LdsLicense {
  id: string;
  name: string;
  url: string;
  openData: boolean;
}

export const LDS_LICENSES: LdsLicense[] = [
  {
    id: 'CC0-1.0',
    name: 'Creative Commons Zero v1.0 Universal (public domain dedication)',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    openData: true,
  },
  {
    id: 'PDDL-1.0',
    name: 'Open Data Commons Public Domain Dedication and License v1.0',
    url: 'https://opendatacommons.org/licenses/pddl/1.0/',
    openData: true,
  },
  {
    id: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    openData: true,
  },
  {
    id: 'CC-BY-SA-4.0',
    name: 'Creative Commons Attribution-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    openData: true,
  },
  {
    id: 'ODbL-1.0',
    name: 'Open Data Commons Open Database License v1.0',
    url: 'https://opendatacommons.org/licenses/odbl/1.0/',
    openData: true,
  },
  {
    id: 'LicenseRef-Proprietary',
    name: 'Proprietary / internal use only (not open data)',
    url: 'https://synapseone.space/licenses/proprietary',
    openData: false,
  },
];

export function findLicense(id: unknown): LdsLicense | null {
  if (typeof id !== 'string' || !id) return null;
  return LDS_LICENSES.find((l) => l.id === id) || null;
}

/** Custom license ids stay namespaced (`LicenseRef-*`) so they can never
 *  shadow a built-in SPDX entry. */
export function isCustomLicenseId(id: string): boolean {
  return /^LicenseRef-[A-Za-z0-9._-]{1,128}$/.test(id);
}

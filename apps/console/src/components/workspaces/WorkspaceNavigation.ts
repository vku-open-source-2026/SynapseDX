// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext } from 'react';
/** Only pages already authorized and returned by the installed API. */
export const WorkspaceNavigation = createContext<readonly string[] | null>(null);
export const WorkspaceModules = createContext<readonly string[] | null>(null);

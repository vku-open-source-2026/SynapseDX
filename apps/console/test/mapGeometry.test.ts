// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { it, expect } from 'vitest';
import { recordGeometry } from '../src/lib/mapGeometry';
it('accepts WGS84 points, stored JSON and GeoJSON features',()=>{
 expect(recordGeometry({latitude:16,longitude:108})).toEqual({type:'Point',coordinates:[108,16]});
 expect(recordGeometry({current_location_json:'{"lat":16,"lng":108}'})).toEqual({type:'Point',coordinates:[108,16]});
 expect(recordGeometry({geometry:{type:'Feature',geometry:{type:'Polygon',coordinates:[[[108,16],[109,16],[109,17],[108,16]]]}}})?.type).toBe('Polygon');
});
it('rejects missing, null, nonfinite and out-of-range coordinates at every geometry depth',()=>{
 for(const row of [{},{latitude:null,longitude:null},{latitude:'',longitude:''},{location:{lat:null,lng:null}},{latitude:Infinity,longitude:108},{geometry:{type:'Point',coordinates:[108,100]}},{geometry:{type:'Polygon',coordinates:[[[181,16],[109,16],[181,16]]]}}]) expect(recordGeometry(row)).toBeNull();
 expect(recordGeometry({latitude:0,longitude:0})).toEqual({type:'Point',coordinates:[0,0]});
});

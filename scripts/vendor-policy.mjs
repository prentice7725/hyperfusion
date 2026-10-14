import {VENDORS,vendorOf} from './member-registry.mjs';
export function validateVendors(list) {
 if(!Array.isArray(list)||list.some(v=>!VENDORS.includes(v))||new Set(list).size!==list.length)throw Error('VENDOR_POLICY: allowed_vendors must be a distinct array of known vendors');
 return list;
}
export function vendorAllowed(configuration,name,env=process.env) {
 const vendor=vendorOf(name);
 if(!vendor)return false;
 if(env.HF_ALLOWED_VENDORS!==undefined&&!env.HF_ALLOWED_VENDORS.trim())throw Error('VENDOR_POLICY: HF_ALLOWED_VENDORS is empty; unset it or specify vendors');
 const operator=env.HF_ALLOWED_VENDORS===undefined?null:validateVendors(env.HF_ALLOWED_VENDORS.split(',').map(s=>s.trim()));
 const repo=configuration?.allowed_vendors===undefined?null:validateVendors(configuration.allowed_vendors);
 return (!operator||operator.includes(vendor))&&(!repo||repo.includes(vendor));
}
export function assertVendor(configuration,name) {
 if(!vendorAllowed(configuration,name))throw Error(`VENDOR_POLICY: ${name} (${vendorOf(name)??'unknown'}) is not permitted`);
}

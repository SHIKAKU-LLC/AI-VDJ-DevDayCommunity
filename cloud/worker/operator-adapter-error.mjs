export class OperatorAdapterHold extends Error{constructor(code){super(code);this.code=code;}}
export const adapterFail=code=>{throw new OperatorAdapterHold(code);};
export const adapterGuard=async(fn,code)=>{try{return await fn();}catch(e){if(e instanceof OperatorAdapterHold)throw e;adapterFail(code);}};

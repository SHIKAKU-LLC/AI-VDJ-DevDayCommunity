// Native Fetch adapter; platform header values never leave the server runtime.
export function createOwnerLinkPlatform({projectURL,serverHeaders,fetcher=fetch}){
 return {
  async requestLink(email,challenge,redirect){
   const url=new URL(projectURL+'/auth/v1/otp');url.searchParams.set('redirect_to',redirect);
   const r=await fetcher(url,{method:'POST',headers:serverHeaders,
    body:JSON.stringify({email,create_user:false,code_challenge:challenge,code_challenge_method:'s256'}),signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw Error('ROOM_BACKEND_UNAVAILABLE');
  },
  async exchangeLink(code,verifier){
   const r=await fetcher(projectURL+'/auth/v1/token?grant_type=pkce',{method:'POST',headers:serverHeaders,
    body:JSON.stringify({auth_code:code,code_verifier:verifier}),signal:AbortSignal.timeout(8000)});
   if(!r.ok)return null;const data=await r.json();
   return {bearer:data.access_token,expiresAt:data.expires_at??Math.floor(Date.now()/1000)+data.expires_in};
  }
 };
}

import { verificationContext, supabaseRequest, verificationFailure } from '@/lib/driver-verification-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{
  const context=await verificationContext(request);
  const isAdmin=await supabaseRequest<boolean>(context,'/rest/v1/rpc/humsafar_is_driver_verification_admin',{method:'POST',body:'{}'});
  return Response.json({isAdmin:isAdmin===true},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return verificationFailure(error)}
}

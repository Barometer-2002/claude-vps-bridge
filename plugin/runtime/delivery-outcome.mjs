// Only evidence at the submitting boundary can prove non-delivery.
export function deliveryError(code,message,delivery='unknown'){
  return Object.assign(new Error(message),{code,delivery});
}
export function deliveryOutcome(error){
  return ['not-sent','refused'].includes(error?.delivery)?error.delivery:'unknown';
}
export function submissionFailure(error,{submitted=true}={}){
  if(submitted&&deliveryOutcome(error)==='unknown')throw error;
  return {ok:false,error:{code:error.code??'unavailable',message:error.message,retryable:false}};
}

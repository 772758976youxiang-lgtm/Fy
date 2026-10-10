chrome.action.onClicked.addListener(async () => {
  const url=chrome.runtime.getURL('index.html');
  const contexts=await chrome.runtime.getContexts({contextTypes:['TAB'],documentUrls:[url]});
  if(contexts.length){await chrome.tabs.update(contexts[0].tabId,{active:true});await chrome.windows.update(contexts[0].windowId,{focused:true});}
  else await chrome.tabs.create({url});
});

# usage: python3 mfix.py file.html TICKETKEY  -> removes stray <footer>, fixes DEV-xxxx key, opaque bars, reports suspicious words
import re,sys
p,key=sys.argv[1],sys.argv[2]; s=open(p).read()
i=s.find('<footer')
if i>=0:
    j=s.find('</footer>')+9; f=s[i:j]
    if any(w in f for w in ['Reject','Approve','Request Diff','⌘','to submit']):
        s=s[:i]+s[j:]; print('removed stray footer')
s=re.sub(r'DEV-4092',key,s)
s=re.sub(r'bg-surface/\d+ backdrop-blur-(?:xl|md|sm|lg)','bg-surface',s)
open(p,'w').write(s)
print('keys',sorted(set(re.findall(r'(?:DEV|PROJ|ENG)-\d+',s))))
for w in ['Reject','Approve','Sonnet','Opus','GPT','Claude 3','tech lead','Merkle','backdrop-blur','⌘','NEEDS DECISION','webhook url']:
    c=s.lower().count(w.lower())
    if c: print('found',w,c)

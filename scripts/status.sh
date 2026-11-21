#!/usr/bin/env bash
# Prints the TC Desk server's health: its own status note and recent errors.
P=tc-desk
T=$(gcloud auth print-access-token)
echo "== Server status note"
curl -s -H "Authorization: Bearer $T" "https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents/settings/srvstatus" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('fields',{})
for k,v in d.items():
  if k in ('clientId','box','sa','scopes'): continue
  print('  ',k,'=',list(v.values())[0])"
echo "== Recent server errors (last 2 hours)"
gcloud logging read 'resource.type="cloud_run_revision" AND severity>=WARNING' --project $P --freshness=2h --limit 25 --format='value(timestamp,resource.labels.service_name,textPayload,jsonPayload.message)' 2>&1 | cut -c1-300

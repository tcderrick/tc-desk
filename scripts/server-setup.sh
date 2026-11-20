#!/usr/bin/env bash
# Prepares Google Cloud for the TC Desk server. Every step is safe to run again.
P=tc-desk
PN=836507322815
SA=tc-desk-mail@$P.iam.gserviceaccount.com
step() { echo "== $*"; }
try() { "$@" >/tmp/out 2>&1 && echo "   ok" || { echo "   WARN: $(tail -2 /tmp/out | tr '\n' ' ')"; }; }

step "Turning on the Google services the server uses"
try gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  eventarc.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com gmail.googleapis.com iamcredentials.googleapis.com \
  fcm.googleapis.com firestore.googleapis.com logging.googleapis.com compute.googleapis.com --project $P

step "Server account"
gcloud iam service-accounts describe $SA --project $P >/dev/null 2>&1 || try gcloud iam service-accounts create tc-desk-mail --display-name="TC Desk mail server" --project $P
sleep 5
try gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator --project $P
for r in roles/datastore.user roles/firebasecloudmessaging.admin roles/logging.logWriter roles/eventarc.eventReceiver roles/run.invoker roles/pubsub.subscriber; do
  step "  role $r"; try gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=$r --condition=None --quiet
done

step "Build permissions (needed on newer Google Cloud projects)"
for m in serviceAccount:$PN-compute@developer.gserviceaccount.com serviceAccount:$PN@cloudbuild.gserviceaccount.com; do
  for r in roles/cloudbuild.builds.builder roles/logging.logWriter roles/artifactregistry.writer roles/storage.objectViewer; do
    try gcloud projects add-iam-policy-binding $P --member=$m --role=$r --condition=None --quiet
  done
done
try gcloud projects add-iam-policy-binding $P --member=serviceAccount:service-$PN@gcp-sa-pubsub.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator --condition=None --quiet
try gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:github-deploy@$P.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser --project $P

step "Mail alert channel (Gmail tells TC Desk about new mail here)"
gcloud pubsub topics describe gmail-in --project $P >/dev/null 2>&1 || try gcloud pubsub topics create gmail-in --project $P
try gcloud pubsub topics add-iam-policy-binding gmail-in --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher --project $P

step "Done"
gcloud projects get-iam-policy $P --flatten="bindings[].members" --filter="bindings.members:github-deploy@" --format="value(bindings.role)" 2>/dev/null | sed 's/^/   deploy account has: /'
# rerun after deploy account was given Owner

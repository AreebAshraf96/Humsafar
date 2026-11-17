"""Advisory document checks. OCR text/names/numbers are never persisted or logged."""
from datetime import date, datetime
import re
from zoneinfo import ZoneInfo
import cv2
import numpy as np

ocr_engine = None

def load_ocr():
    global ocr_engine
    try:
        from rapidocr import RapidOCR
        ocr_engine = RapidOCR(params={'Global.log_level':'error','EngineConfig.onnxruntime.intra_op_num_threads':2,'EngineConfig.onnxruntime.inter_op_num_threads':2})
    except Exception:
        # Face comparison and manual review remain usable if OCR cannot start.
        ocr_engine = None

def normalized_name(value):
    return " ".join("".join(c.casefold() if c.isalpha() else " " for c in value).split())

def parse_date(value):
    value = re.sub(r"[.,]", "", value.strip())
    match = re.search(r"\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/ ](?:[A-Za-z]{3,9}|\d{1,2})[-/ ]\d{4})\b", value)
    if not match: return None, False
    token = match.group(1)
    parts = re.split(r"[-/ ]", token)
    if len(parts[0]) != 4 and parts[1].isdigit() and int(parts[0]) <= 12 and int(parts[1]) <= 12 and parts[0] != parts[1]:
        return None, True
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y", "%d %m %Y", "%d-%b-%Y", "%d %b %Y", "%d/%b/%Y", "%d-%B-%Y", "%d %B %Y"):
        try: return datetime.strptime(token, fmt).date(), False
        except ValueError: pass
    return None, False

def labelled_value(lines, pattern):
    values=[]
    for index,line in enumerate(lines):
        match=re.match(pattern,line,re.I)
        if match:
            value=line[match.end():].strip(" :-")
            if not value and index+1<len(lines): value=lines[index+1]
            if value: values.append(value)
    return values

def check_text(lines, declared_name="", today=None):
    today=today or datetime.now(ZoneInfo("Asia/Karachi")).date()
    reasons=[]
    expiry_values=labelled_value(lines,r"^(?:date of expiry|expiry(?: date)?|expiration(?: date)?|expires(?: on)?|valid (?:until|to))\b")
    dates=[];ambiguous=False
    for value in expiry_values:
        parsed,uncertain=parse_date(value);ambiguous=ambiguous or uncertain
        if parsed: dates.append(parsed)
    unique=set(dates)
    expiry=next(iter(unique)) if len(unique)==1 and not ambiguous else None
    expiry_status="ambiguous" if ambiguous or len(unique)>1 else "unreadable" if expiry is None else "expired" if expiry<today else "valid"
    reasons.append({"valid":"Printed expiry appears current; a reviewer must confirm it.","expired":"Printed expiry appears to be in the past. Check the image or provide a current licence.","ambiguous":"The expiry date is ambiguous. A reviewer must confirm the date format.","unreadable":"Could not confidently read a labelled expiry date. Use a clear image showing all details."}[expiry_status])
    names=labelled_value(lines,r"^(?:full name|name)\b")
    expected=normalized_name(declared_name)
    name_status="not_provided" if not expected else "unreadable" if len(names)!=1 else "consistent" if normalized_name(names[0])==expected else "different"
    reasons.append({"consistent":"Printed name appears consistent with the name you supplied.","different":"Printed name differs from the name supplied. Check spelling and ask a reviewer to confirm.","unreadable":"Could not confidently read a labelled full name.","not_provided":"No declared full name was provided for text comparison."}[name_status])
    number_values=labelled_value(lines,r"^(?:driving\s+)?licen[cs]e\s*(?:number|no\.?|#)\s*[:\-]?")
    number_present=any(5<=len(re.sub(r"[^A-Za-z0-9]","",value))<=30 for value in number_values)
    if not number_present: reasons.append("Could not confidently locate a labelled licence number.")
    return {"state":"review_required", "expiryDate":expiry.isoformat() if expiry else None,"expiryStatus":expiry_status,"nameStatus":name_status,"licenceNumberPresent":number_present,"reasons":reasons}

def image_quality(image):
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    return {"resolutionOk":min(gray.shape)>=320,"sharpnessOk":float(cv2.Laplacian(gray,cv2.CV_64F).var())>=35,"lightingOk":float(np.mean(gray))>=25 and float(np.std(gray))>=8}

def document_checks(licence, selfie, declared_name=""):
    quality={"licence":image_quality(licence),"selfie":image_quality(selfie)}
    if ocr_engine is None:
        result={"state":"unavailable","expiryDate":None,"expiryStatus":"unreadable","nameStatus":"unreadable","licenceNumberPresent":False,"reasons":["Document text checking is unavailable. Your documents can still be reviewed by an administrator."]}
    else:
        try:
            result=ocr_engine(licence)
            lines=[str(text).strip() for text,confidence in zip(result.txts if result.txts is not None else (),result.scores if result.scores is not None else ()) if float(confidence)>=0.85]
            result=check_text(lines,declared_name)
        except Exception:
            result={"state":"unavailable","expiryDate":None,"expiryStatus":"unreadable","nameStatus":"unreadable","licenceNumberPresent":False,"reasons":["Document text could not be checked reliably. Administrator review is required."]}
    for label,checks in quality.items():
        for key,message in [("resolutionOk","image is too small"),("sharpnessOk","image may be blurry"),("lightingOk","image may be too dark or overexposed")]:
            if not checks[key]: result["reasons"].append(label.capitalize()+" "+message+". Please use a clearer photo.")
    result["quality"]=quality
    # No account/driver approval or rejection is performed here.
    return result

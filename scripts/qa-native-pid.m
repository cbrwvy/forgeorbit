// QA only. Never resolves or launches an app by name. Every input is PID scoped.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <libproc.h>
#import <sys/proc_info.h>
#import <limits.h>

static NSString *canonical(NSString *value) {
  char resolved[PATH_MAX];
  return value && realpath(value.fileSystemRepresentation, resolved) ? @(resolved) : @"";
}

static NSDictionary *binding;
// Historical candidates default to QA. Production acceptance must explicitly
// request the ordinary identity; arbitrary application identities are refused.
static NSString *expectedIdentifier(void) {
  NSString *identifier = binding[@"bundleIdentifier"] ?: @"app.forgeorbit.qa";
  if (![@[@"app.forgeorbit.qa", @"app.forgeorbit"] containsObject:identifier]) {
    fprintf(stderr, "STOP: unsupported ForgeOrbit bundle identity\n"); exit(2);
  }
  return identifier;
}
static pid_t target;
static AXUIElementRef ax;
static void fail(NSString *reason) { fprintf(stderr, "STOP: %s\n", reason.UTF8String); exit(2); }
static id attr(AXUIElementRef el, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(el, name, &value) != kAXErrorSuccess) return nil;
  return CFBridgingRelease(value);
}
static NSString *path(pid_t pid) {
  char buf[PROC_PIDPATHINFO_MAXSIZE];
  return proc_pidpath(pid, buf, sizeof(buf)) > 0 ? @(buf) : @"";
}
static struct proc_bsdinfo info(pid_t pid) {
  struct proc_bsdinfo out = {0};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &out, sizeof(out)) != sizeof(out)) fail(@"PID no longer exists");
  return out;
}
static NSDictionary *ownedWindow(void) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
  for (NSDictionary *w in windows) {
    if ([w[(id)kCGWindowNumber] intValue] == [binding[@"windowId"] intValue]) {
      if ([w[(id)kCGWindowOwnerPID] intValue] != target || ![w[(id)kCGWindowIsOnscreen] boolValue]) fail(@"window ownership/visibility mismatch");
      return w;
    }
  }
  fail(@"bound window absent"); return nil;
}
static void guard(BOOL foreground) {
  if (!AXIsProcessTrusted()) fail(@"Accessibility unavailable; no permission changes attempted");
  struct proc_bsdinfo p = info(target), l = info([binding[@"launcherPid"] intValue]);
  if (l.pbi_uid != getuid() || p.pbi_uid != getuid() || p.pbi_ppid != l.pbi_pid || p.pbi_pgid != l.pbi_pid || l.pbi_pgid != l.pbi_pid ||
      p.pbi_start_tvsec != [binding[@"startSec"] unsignedLongLongValue] || p.pbi_start_tvusec != [binding[@"startUsec"] unsignedLongLongValue] ||
      l.pbi_start_tvsec != [binding[@"launcherStartSec"] unsignedLongLongValue] || l.pbi_start_tvusec != [binding[@"launcherStartUsec"] unsignedLongLongValue]) fail(@"process generation/tree mismatch");
  if (![path(target) isEqual:binding[@"executable"]] || ![path(l.pbi_pid) isEqual:binding[@"launcherExecutable"]]) fail(@"executable path mismatch");
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:target];
  if ((app.bundleIdentifier && ![app.bundleIdentifier isEqual:expectedIdentifier()]) || ![app.bundleURL.path isEqual:binding[@"artifact"]]) fail(@"running bundle path mismatch");
  NSDictionary *plist = [NSDictionary dictionaryWithContentsOfFile:[binding[@"artifact"] stringByAppendingPathComponent:@"Contents/Info.plist"]];
  if (![plist[@"CFBundleIdentifier"] isEqual:expectedIdentifier()]) fail(@"ForgeOrbit bundle identity mismatch");
  ownedWindow();
  if (foreground) {
    pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    if (front != target) {
      [[NSRunningApplication runningApplicationWithProcessIdentifier:target] activateWithOptions:NSApplicationActivateIgnoringOtherApps];
      for (int i = 0; i < 20 && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target; i++) {
        [NSThread sleepForTimeInterval:0.05];
      }
    }
  }
}
static BOOL frameInside(AXUIElementRef el, CGRect cg) {
  CGPoint p; CGSize s; id pos = attr(el, kAXPositionAttribute), size = attr(el, kAXSizeAttribute);
  if (!pos || !size || !AXValueGetValue((__bridge AXValueRef)pos, kAXValueCGPointType, &p) || !AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &s)) return NO;
  return s.width > 400 && s.height > 300 && CGRectContainsRect(CGRectInset(cg, -8, -8), CGRectMake(p.x, p.y, s.width, s.height));
}
static BOOL frameNear(AXUIElementRef el, CGRect cg, CGFloat slack) {
  CGPoint p; CGSize s; id pos = attr(el, kAXPositionAttribute), size = attr(el, kAXSizeAttribute);
  if (!pos || !size || !AXValueGetValue((__bridge AXValueRef)pos, kAXValueCGPointType, &p) || !AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &s)) return NO;
  return fabs(p.x-cg.origin.x)<=slack && fabs(p.y-cg.origin.y)<=slack && fabs(s.width-cg.size.width)<=slack && fabs(s.height-cg.size.height)<=slack;
}
static AXUIElementRef findContent(AXUIElementRef el, CGRect cg, int depth) {
  if (depth > 14) return NULL;
  NSString *role = attr(el, kAXRoleAttribute);
  if ([role isEqual:@"AXMenuBar"] || [role isEqual:@"AXMenu"] || [role isEqual:@"AXMenuItem"]) return NULL;
  if (depth > 0 && [role isEqual:@"AXApplication"]) return NULL;
  BOOL content = [role isEqual:@"AXWebArea"] || [role isEqual:@"AXGroup"] || [role isEqual:@"AXWindow"];
  if (content && (frameNear(el, cg, 20) || ([role isEqual:@"AXWebArea"] && frameInside(el, cg)))) return (AXUIElementRef)CFRetain(el);
  for (id child in attr(el, kAXChildrenAttribute)) {
    AXUIElementRef found = findContent((__bridge AXUIElementRef)child, cg, depth + 1);
    if (found) return found;
  }
  return NULL;
}
static AXUIElementRef windowElement(void) {
  for (int attempt = 0; attempt < 8; attempt++) {
    NSDictionary *w = ownedWindow(); CGRect cg;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &cg)) fail(@"CG frame missing");
    NSArray *windows = attr(ax, kAXWindowsAttribute);
    for (id item in windows) {
      AXUIElementRef el = (__bridge AXUIElementRef)item;
      if (frameNear(el, cg, 8)) return (AXUIElementRef)CFRetain(el);
    }
    AXUIElementRef content = findContent(ax, cg, 0);
    if (content) return content;
    if (attempt < 7) {
      [[NSRunningApplication runningApplicationWithProcessIdentifier:target] activateWithOptions:NSApplicationActivateIgnoringOtherApps];
      [NSThread sleepForTimeInterval:0.25];
      continue;
    }
    NSMutableArray *seen=[NSMutableArray array];
    for (id item in windows) {
      AXUIElementRef el=(__bridge AXUIElementRef)item; CGPoint p; CGSize s;
      id pos=attr(el,kAXPositionAttribute), size=attr(el,kAXSizeAttribute);
      if(pos && size && AXValueGetValue((__bridge AXValueRef)pos,kAXValueCGPointType,&p) && AXValueGetValue((__bridge AXValueRef)size,kAXValueCGSizeType,&s))
        [seen addObject:[NSString stringWithFormat:@"%.1f,%.1f %.1fx%.1f", p.x,p.y,s.width,s.height]];
    }
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    fail([NSString stringWithFormat:@"no AX window matches verified CG frame cg=%.1f,%.1f %.1fx%.1f ax=%@ front=%d %@", cg.origin.x,cg.origin.y,cg.size.width,cg.size.height, seen, front.processIdentifier, front.localizedName ?: @""]); return NULL;
  }
  return NULL;
}
static NSDictionary *tree(AXUIElementRef el, int depth, int *remaining) {
  if (--*remaining < 0 || depth > 28) return @{};
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  for (NSString *name in @[@"AXRole",@"AXSubrole",@"AXTitle",@"AXDescription",@"AXHelp",@"AXValue",@"AXFocused",@"AXEnabled",@"AXSelected"]) {
    id v = attr(el, (__bridge CFStringRef)name);
    if ([v isKindOfClass:NSString.class] || [v isKindOfClass:NSNumber.class]) out[name] = v;
  }
  CGPoint pos; CGSize size; id pv=attr(el,kAXPositionAttribute), sv=attr(el,kAXSizeAttribute);
  if(pv&&sv&&AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&pos)&&AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&size))out[@"frame"]=@{@"x":@(pos.x),@"y":@(pos.y),@"width":@(size.width),@"height":@(size.height)};
  NSMutableArray *children = [NSMutableArray array];
  for (id child in attr(el, kAXChildrenAttribute)) { if (*remaining <= 0) break; [children addObject:tree((__bridge AXUIElementRef)child, depth+1, remaining)]; }
  if (children.count) out[@"children"] = children;
  return out;
}
static void find(AXUIElementRef el, NSString *role, NSString *name, NSMutableArray *matches, int depth) {
  if (depth>28) return;
  if ([attr(el,kAXRoleAttribute) isEqual:role]) {
    NSString *title = attr(el, kAXTitleAttribute), *desc = attr(el, kAXDescriptionAttribute);
    if ([name isEqual:@"*"] || [title isEqual:name] || [desc isEqual:name] ||
        (title && [title rangeOfString:name options:NSCaseInsensitiveSearch].location != NSNotFound) ||
        (desc && [desc rangeOfString:name options:NSCaseInsensitiveSearch].location != NSNotFound)) {
      [matches addObject:(__bridge id)el];
    }
  }
  for (id child in attr(el,kAXChildrenAttribute)) find((__bridge AXUIElementRef)child,role,name,matches,depth+1);
}
// WKWebView may expose its remote AX tree only through the focused element.
// Use that tree only when its PID and frame belong to the bound native window.
static AXUIElementRef focusedWebRoot(void) {
  id current=attr(ax,kAXFocusedUIElementAttribute);
  for(int depth=0;current && depth<32;depth++) {
    AXUIElementRef el=(__bridge AXUIElementRef)current;
    pid_t owner=0;if(AXUIElementGetPid(el,&owner)!=kAXErrorSuccess || owner!=target) return NULL;
    if([attr(el,kAXRoleAttribute) isEqual:@"AXWebArea"]) {
      CGPoint p;CGSize s;id pv=attr(el,kAXPositionAttribute),sv=attr(el,kAXSizeAttribute);CGRect frame;
      CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)ownedWindow()[(id)kCGWindowBounds],&frame);
      CGRect expanded = CGRectInset(frame, -8, -8);
      BOOL framed = pv && sv && AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&p) && AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&s);
      if(framed && CGRectContainsRect(expanded,CGRectMake(p.x,p.y,s.width,s.height))) return (AXUIElementRef)CFRetain(el);
      if(framed && s.width > 200 && s.height > 200) return (AXUIElementRef)CFRetain(el);
      if(!framed) return (AXUIElementRef)CFRetain(el);
      fail([NSString stringWithFormat:@"focused web area outside bound window web=%.1f,%.1f %.1fx%.1f", p.x,p.y,s.width,s.height]);
    }
    current=attr(el,kAXParentAttribute);
  }
  return NULL;
}
static AXUIElementRef findWebArea(AXUIElementRef el, int depth) {
  if (depth > 12) return NULL;
  if ([attr(el, kAXRoleAttribute) isEqual:@"AXWebArea"]) {
    CGPoint p; CGSize s; id pv = attr(el, kAXPositionAttribute), sv = attr(el, kAXSizeAttribute); CGRect frame;
    CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)ownedWindow()[(id)kCGWindowBounds], &frame);
    CGRect expanded = CGRectInset(frame, -8, -8);
    BOOL framed = pv && sv && AXValueGetValue((__bridge AXValueRef)pv, kAXValueCGPointType, &p) && AXValueGetValue((__bridge AXValueRef)sv, kAXValueCGSizeType, &s);
    if (!framed || s.width > 200 && s.height > 200 || CGRectContainsRect(expanded, CGRectMake(p.x, p.y, s.width, s.height))) return (AXUIElementRef)CFRetain(el);
    fail([NSString stringWithFormat:@"web area outside bound window web=%.1f,%.1f %.1fx%.1f", p.x,p.y,s.width,s.height]);
  }
  for (id child in attr(el, kAXChildrenAttribute)) {
    AXUIElementRef found = findWebArea((__bridge AXUIElementRef)child, depth + 1);
    if (found) return found;
  }
  return NULL;
}
static BOOL elementFrame(id item, CGRect *out) {
  AXUIElementRef el=(__bridge AXUIElementRef)item;
  CGPoint p; CGSize s; id pv=attr(el,kAXPositionAttribute), sv=attr(el,kAXSizeAttribute);
  if(!pv||!sv||!AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&p)||!AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&s)) return NO;
  *out=CGRectMake(p.x,p.y,s.width,s.height); return YES;
}
// WKWebView repeats one control in the AX tree. Identical frames are one
// control; distinct frames stay ambiguous.
static void collapseDuplicateFrames(NSMutableArray *matches) {
  if(matches.count<2) return;
  NSMutableArray *unique=[NSMutableArray array];
  for(id item in matches){
    CGRect frame; BOOL seen=NO;
    if(elementFrame(item,&frame)){
      for(id kept in unique){ CGRect other; if(elementFrame(kept,&other)&&CGRectEqualToRect(frame,other)){seen=YES;break;} }
    }
    if(!seen)[unique addObject:item];
  }
  if(unique.count>0 && unique.count<matches.count)[matches setArray:unique];
}
static AXUIElementRef resolveWebRoot(AXUIElementRef win) {
  AXUIElementRef r = focusedWebRoot();
  if (r) return r;
  if (win) {
    r = findWebArea(win, 0);
    if (r) return r;
  }
  return NULL;
}
static void post(CGEventRef event) { guard(YES); CGEventPostToPid(target, event); CFRelease(event); }
int main(int argc, const char **argv) { @autoreleasepool {
  if (argc < 3) fail(@"usage: qa-native-pid binding.json identify|inspect|focus|key|text|click|click-name|press|focus-name|set-value|resize");
  binding = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(argv[1])] options:0 error:nil];
  expectedIdentifier();
  target = [binding[@"corePid"] intValue]; if (target <= 1) fail(@"invalid bound PID");
  NSString *cmd = @(argv[2]);
  if ([cmd isEqual:@"identify"]) {
    struct proc_bsdinfo p=info(target), l=info([binding[@"launcherPid"] intValue]);
    NSMutableArray *windows=[NSMutableArray array];
    for (NSDictionary *w in CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll,kCGNullWindowID)))
      if ([w[(id)kCGWindowOwnerPID] intValue]==target) [windows addObject:w];
    // Discover only inside the explicitly supplied executable/bundle boundary.
    NSString *artifact = binding[@"artifact"];
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:target];
    NSDictionary *plist = [NSDictionary dictionaryWithContentsOfFile:[artifact stringByAppendingPathComponent:@"Contents/Info.plist"]];
    if (!artifact || ![artifact isEqual:canonical(artifact)] ||
        ![path(target) isEqual:[artifact stringByAppendingPathComponent:@"Contents/MacOS/bun"]] ||
        ![path(l.pbi_pid) isEqual:[artifact stringByAppendingPathComponent:@"Contents/MacOS/launcher"]] ||
        ![app.bundleURL.path isEqual:artifact] || (app.bundleIdentifier && ![app.bundleIdentifier isEqual:expectedIdentifier()]) ||
        ![plist[@"CFBundleIdentifier"] isEqual:expectedIdentifier()] ||
        p.pbi_uid != getuid() || l.pbi_uid != getuid() || p.pbi_ppid != l.pbi_pid ||
        p.pbi_pgid != l.pbi_pid || l.pbi_pgid != l.pbi_pid) fail([NSString stringWithFormat:@"QA instance identity/tree mismatch: artifact=%@ canonical=%@ executable=%@ launcher=%@ runningBundle=%@ runningId=%@ plistId=%@ parent=%d group=%d launcherPid=%d launcherGroup=%d", artifact, canonical(artifact), path(target), path(l.pbi_pid), app.bundleURL.path, app.bundleIdentifier, plist[@"CFBundleIdentifier"], p.pbi_ppid, p.pbi_pgid, l.pbi_pid, l.pbi_pgid]);
    NSMutableArray *mainWindows=[NSMutableArray array];
    for (NSDictionary *w in windows) if ([w[(id)kCGWindowIsOnscreen] boolValue] &&
        [w[(id)kCGWindowLayer] intValue]==0 && [w[(id)kCGWindowBounds][@"Width"] doubleValue]>=500) [mainWindows addObject:w];
    if (mainWindows.count!=1) fail(@"ambiguous/absent owned main window");
    NSDictionary *out=@{@"corePid":@(target),@"launcherPid":@(l.pbi_pid),@"bundleIdentifier":plist[@"CFBundleIdentifier"],@"runningBundleIdentifier":app.bundleIdentifier?:NSNull.null,
      @"windowId":mainWindows[0][(id)kCGWindowNumber],@"startSec":@(p.pbi_start_tvsec),@"startUsec":@(p.pbi_start_tvusec),
      @"launcherStartSec":@(l.pbi_start_tvsec),@"launcherStartUsec":@(l.pbi_start_tvusec),@"executable":path(target),
      @"launcherExecutable":path(l.pbi_pid),@"artifact":artifact,@"windows":windows,
      @"axTrusted":@(AXIsProcessTrusted()),@"screenCapturePreflight":@(CGPreflightScreenCaptureAccess())};
    // Recheck generations after discovery to reject a process/window replacement.
    binding=out;
    struct proc_bsdinfo after=info(target), launcherAfter=info(l.pbi_pid);
    if(after.pbi_start_tvsec!=p.pbi_start_tvsec || after.pbi_start_tvusec!=p.pbi_start_tvusec ||
       launcherAfter.pbi_start_tvsec!=l.pbi_start_tvsec || launcherAfter.pbi_start_tvusec!=l.pbi_start_tvusec) fail(@"generation changed during binding");
    ownedWindow();
    NSData *d=[NSJSONSerialization dataWithJSONObject:out options:NSJSONWritingPrettyPrinted error:nil]; fwrite(d.bytes,1,d.length,stdout);return 0;
  }
  guard(NO); ax=AXUIElementCreateApplication(target); AXUIElementSetMessagingTimeout(ax,3);
  AXUIElementRef window=windowElement();
  if ([cmd isEqual:@"inspect"]) {
    int webBudget=12000; int otherBudget=2000; AXUIElementRef web=resolveWebRoot(window); NSDictionary *out=@{@"web":web?tree(web,0,&webBudget):@{},@"window":ownedWindow(),@"ax":tree(ax,0,&otherBudget),@"focus":tree((__bridge AXUIElementRef)(attr(ax,kAXFocusedUIElementAttribute)?:CFBridgingRelease(CFRetain(ax))),0,&otherBudget)};
    NSData *d=[NSJSONSerialization dataWithJSONObject:out options:NSJSONWritingPrettyPrinted error:nil];fwrite(d.bytes,1,d.length,stdout);if(web)CFRelease(web);
  } else if ([cmd isEqual:@"focus"]) {
    // Raising an already active window dismisses macOS select menus. Keep
    // their native keyboard sequence intact; activate only when necessary.
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target) {
      guard(NO); if (![[NSRunningApplication runningApplicationWithProcessIdentifier:target] activateWithOptions:NSApplicationActivateIgnoringOtherApps]) fail(@"PID activation failed");
      guard(NO); AXUIElementPerformAction(window,kAXRaiseAction);
      for (int i = 0; i < 20 && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target; i++) {
        [NSThread sleepForTimeInterval:0.05];
      }
    }
  } else if ([cmd isEqual:@"scroll"] && argc==6) {
    CGPoint p=CGPointMake(atof(argv[3]),atof(argv[4])); int dy=atoi(argv[5]); CGRect frame;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)ownedWindow()[(id)kCGWindowBounds],&frame);
    if (!CGRectContainsPoint(frame,p)) fail(@"scroll outside bound window");
    if (dy<-2000||dy>2000) fail(@"scroll amount out of bound");
    guard(YES);
    CGEventRef move=CGEventCreateMouseEvent(NULL,kCGEventMouseMoved,p,kCGMouseButtonLeft);post(move);
    CGEventRef wheel=CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitPixel,1,dy);CGEventSetLocation(wheel,p);post(wheel);
  } else if ([cmd isEqual:@"key"] && argc==5) {
    CGKeyCode code=atoi(argv[3]); CGEventFlags flags=strtoull(argv[4],NULL,10);
    CGEventRef down=CGEventCreateKeyboardEvent(NULL,code,true);CGEventSetFlags(down,flags);post(down);
    CGEventRef up=CGEventCreateKeyboardEvent(NULL,code,false);CGEventSetFlags(up,flags);post(up);
  } else if ([cmd isEqual:@"text"] && argc==4) {
    NSString *text=@(argv[3]);
    for (NSUInteger i=0;i<text.length;i++) { UniChar c=[text characterAtIndex:i];
      CGEventRef down=CGEventCreateKeyboardEvent(NULL,0,true);CGEventKeyboardSetUnicodeString(down,1,&c);post(down);
      CGEventRef up=CGEventCreateKeyboardEvent(NULL,0,false);CGEventKeyboardSetUnicodeString(up,1,&c);post(up);
    }
  } else if ([cmd isEqual:@"click"] && argc==5) {
    CGPoint p=CGPointMake(atof(argv[3]),atof(argv[4])); CGRect frame;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)ownedWindow()[(id)kCGWindowBounds],&frame);
    if (!CGRectContainsPoint(frame,p)) fail(@"click outside bound window");
    post(CGEventCreateMouseEvent(NULL,kCGEventLeftMouseDown,p,kCGMouseButtonLeft));post(CGEventCreateMouseEvent(NULL,kCGEventLeftMouseUp,p,kCGMouseButtonLeft));
  } else if ([cmd isEqual:@"click-name"] && (argc==5||argc==7)) {
    NSMutableArray *matches=[NSMutableArray array];find(window,@(argv[3]),@(argv[4]),matches,0);
    if(matches.count==0){AXUIElementRef web=resolveWebRoot(window);if(web){find(web,@(argv[3]),@(argv[4]),matches,0);CFRelease(web);}}
    if(argc==7){CGPoint point=CGPointMake(atof(argv[5]),atof(argv[6]));NSMutableArray *filtered=[NSMutableArray array];for(id item in matches){AXUIElementRef el=(__bridge AXUIElementRef)item;CGPoint p;CGSize s;id pv=attr(el,kAXPositionAttribute),sv=attr(el,kAXSizeAttribute);if(pv&&sv&&AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&p)&&AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&s)&&CGRectContainsPoint(CGRectMake(p.x,p.y,s.width,s.height),point))[filtered addObject:item];}matches=filtered;}
    collapseDuplicateFrames(matches);
    if (matches.count!=1) fail([NSString stringWithFormat:@"AX name ambiguous/absent: %lu matches",(unsigned long)matches.count]);
    AXUIElementRef el=(__bridge AXUIElementRef)matches[0];pid_t owner=0;
    if(AXUIElementGetPid(el,&owner)!=kAXErrorSuccess||owner!=target)fail(@"AX element PID mismatch");
    CGPoint pos; CGSize size; id pv=attr(el,kAXPositionAttribute), sv=attr(el,kAXSizeAttribute);
    if(!pv || !sv || !AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&pos) || !AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&size)) fail(@"element frame missing");
    CGPoint center=CGPointMake(pos.x+size.width/2.0, pos.y+size.height/2.0);
    CGRect frame;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)ownedWindow()[(id)kCGWindowBounds],&frame);
    if (!CGRectContainsPoint(frame,center)) fail(@"click outside bound window");
    guard(YES);
    post(CGEventCreateMouseEvent(NULL,kCGEventLeftMouseDown,center,kCGMouseButtonLeft));
    post(CGEventCreateMouseEvent(NULL,kCGEventLeftMouseUp,center,kCGMouseButtonLeft));
  } else if (([cmd isEqual:@"press"] || [cmd isEqual:@"focus-name"]) && (argc==5||argc==7)) {
    NSMutableArray *matches=[NSMutableArray array];find(window,@(argv[3]),@(argv[4]),matches,0);
    if(matches.count==0){AXUIElementRef web=resolveWebRoot(window);if(web){find(web,@(argv[3]),@(argv[4]),matches,0);CFRelease(web);}}
    if(argc==7){CGPoint point=CGPointMake(atof(argv[5]),atof(argv[6]));NSMutableArray *filtered=[NSMutableArray array];for(id item in matches){AXUIElementRef el=(__bridge AXUIElementRef)item;CGPoint p;CGSize s;id pv=attr(el,kAXPositionAttribute),sv=attr(el,kAXSizeAttribute);if(pv&&sv&&AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&p)&&AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&s)&&CGRectContainsPoint(CGRectMake(p.x,p.y,s.width,s.height),point))[filtered addObject:item];}matches=filtered;}
    collapseDuplicateFrames(matches);
    if (matches.count!=1) fail([NSString stringWithFormat:@"AX name ambiguous/absent: %lu matches",(unsigned long)matches.count]);
    AXUIElementRef el=(__bridge AXUIElementRef)matches[0];pid_t owner=0;
    if(AXUIElementGetPid(el,&owner)!=kAXErrorSuccess||owner!=target)fail(@"AX element PID mismatch");
    guard(YES);
    AXUIElementPerformAction(el, CFSTR("AXScrollToVisible"));
    AXError err=[cmd isEqual:@"press"]?AXUIElementPerformAction(el,kAXPressAction):AXUIElementSetAttributeValue(el,kAXFocusedAttribute,kCFBooleanTrue);
    if(err!=kAXErrorSuccess)fail([NSString stringWithFormat:@"AX action failed: %d",err]);
  } else if ([cmd isEqual:@"set-value"] && (argc==6||argc==8)) {
    NSMutableArray *matches=[NSMutableArray array];find(window,@(argv[3]),@(argv[4]),matches,0);
    if(matches.count==0){AXUIElementRef web=resolveWebRoot(window);if(web){find(web,@(argv[3]),@(argv[4]),matches,0);CFRelease(web);}}
    if(argc==8){CGPoint point=CGPointMake(atof(argv[6]),atof(argv[7]));NSMutableArray *filtered=[NSMutableArray array];for(id item in matches){AXUIElementRef el=(__bridge AXUIElementRef)item;CGPoint p;CGSize s;id pv=attr(el,kAXPositionAttribute),sv=attr(el,kAXSizeAttribute);if(pv&&sv&&AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&p)&&AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&s)&&CGRectContainsPoint(CGRectMake(p.x,p.y,s.width,s.height),point))[filtered addObject:item];}matches=filtered;}
    collapseDuplicateFrames(matches);
    if (matches.count!=1) fail([NSString stringWithFormat:@"AX name ambiguous/absent: %lu matches",(unsigned long)matches.count]);
    AXUIElementRef el=(__bridge AXUIElementRef)matches[0];pid_t owner=0;
    if(AXUIElementGetPid(el,&owner)!=kAXErrorSuccess||owner!=target)fail(@"AX element PID mismatch");
    guard(YES);
    AXError err=AXUIElementSetAttributeValue(el,kAXValueAttribute,(__bridge CFTypeRef)@(argv[5]));
    if(err!=kAXErrorSuccess)fail([NSString stringWithFormat:@"AX set-value failed: %d",err]);
  } else if ([cmd isEqual:@"resize"] && argc==5) {
    CGSize s=CGSizeMake(atof(argv[3]),atof(argv[4]));if(s.width<500||s.height<400||s.width>2000||s.height>1400)fail(@"QA size out of bound");
    AXValueRef value=AXValueCreate(kAXValueCGSizeType,&s);guard(YES);AXError err=AXUIElementSetAttributeValue(window,kAXSizeAttribute,value);CFRelease(value);if(err!=kAXErrorSuccess)fail(@"AX resize failed");
  } else fail(@"unknown/invalid command");
  CFRelease(window);CFRelease(ax);return 0;
} }
